# TypeScript et Oxc

Le projet utilise TypeScript 7.0.2 pour les contrôles, `@typescript/typescript6` 6.0.2
pour l’API AST du build, `@types/bun` 1.4.2, Oxlint 1.85.0 (avec `oxlint-tsgolint` 7.0.2002
pour le lint type-aware) et Oxfmt 0.70.0.
Toutes ces versions sont fixées dans `package.json` et le lockfile.

`tsconfig.base.json` définit le mode strict, les types Bun (qui exposent aussi les
API Node), la résolution ESM Bundler et le JSX OpenTUI ; il vit dans
`packages/airtty/` et s'exporte en `airtty/tsconfig`, que chaque exemple étend comme un
starter. `packages/airtty/tsconfig.json` couvre le framework, le `tsconfig.json` racine
les tests, les scripts et les sondes, et chaque exemple a le sien. Les imports publics
`airtty/client` et `/server` passent par les exports du package :
aucun alias TypeScript ne masque une dépendance absente.

Le contrôle précédent ne couvrait que `src/` et l’exemple. Les tests/sondes pouvaient
être traités comme des fichiers sans configuration par VS Code, avec des erreurs
sur `node:*` et `process`. Étendre le contrôle a aussi révélé cinq erreurs réelles :
déclaration manquante du décodeur Flight Node, références Client typées comme
fonctions retournant `void`, appel spread d’une fonction typée et inference trop
large des fixtures. Elles sont corrigées sans `ts-ignore` ni désactivation du mode strict.

Flight n’expose pas de déclarations pour les entrées utilisées. `packages/airtty/types.d.ts` contient
le contrat d’intégration local ; les adapters l’incluent aussi pour les applications
consommatrices. Cela ne représente pas une validation statique des données réseau :
la validation métier reste côté Server. `skipLibCheck` est limité à la vérification
des fichiers de déclaration des dépendances ; les sources du projet sont vérifiées.

## Règles strictes

Les règles suivantes sont vérifiées, pas seulement suivies :

| Règle                                                    | Moyen                                                                                               |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Aucun `any`, explicite ou reçu (`JSON.parse`, `.json()`) | `no-explicit-any`, `no-unsafe-*` (type-aware)                                                       |
| Aucune assertion `as` (`as const` reste permis)          | `consistent-type-assertions: never`                                                                 |
| Aucun `!` non-null, aucune assertion inutile             | `no-non-null-assertion`, `no-unnecessary-type-assertion`                                            |
| Ni `@ts-ignore`, ni `@ts-expect-error`, ni `@ts-nocheck` | `ban-ts-comment`                                                                                    |
| Ni `Function`, ni `Object`, ni `object`, ni `{}`         | `no-unsafe-function-type`, `no-wrapper-object-types`, `no-restricted-types`, `no-empty-object-type` |
| Pas d'`enum`, de `namespace` ni de parameter properties  | `erasableSyntaxOnly` (TypeScript)                                                                   |
| `catch (error)` est `unknown`                            | `strict` (TypeScript), `use-unknown-in-catch-callback-variable`                                     |
| Égalité stricte                                          | `eqeqeq`                                                                                            |
| Constantes nommées plutôt que valeurs magiques           | `no-magic-numbers` (hors tests et parcours PTY)                                                     |

Le lint type-aware utilise `oxlint-tsgolint` et les `tsconfig.json` du projet ; il ajoute
les règles de correction qui demandent des types (`await-thenable`, `no-floating-promises`,
`unbound-method`…). `no-magic-numbers` accepte -1, 0, 1, 2, les index et les valeurs par
défaut ; dans les tests, une valeur attendue écrite en clair reste plus lisible qu'une
constante, et il en va de même des parcours PTY (`scripts/pty/`). Sont aussi exemptés
des tables de données de démonstration, où nommer chaque valeur n'ajouterait aucun sens :
`examples/forge/server/ci.ts` et `seed.ts` (horaires du script CI simulé, jeu de données
généré), `packages/airtty/src/devtools/fixtures.ts` (session DevTools simulée) et les
pages du guide du site (`.oxlintrc.json`, `overrides`). `readonly` et `ReadonlyArray`
pour les données immuables ne sont pas vérifiables
automatiquement sans bruit (`prefer-readonly-parameter-types` signale chaque paramètre
d'une bibliothèque) : ils restent une règle de revue.

Les données externes sont validées par Zod, à la frontière où elles entrent ; les données
internes gardent de simples types TypeScript.

## Commandes et CI

- `bun run check` : TypeScript sur le framework, ses applications internes (DevTools,
  lanceur, Client générique, runtime web), les exemples, les tests, les scripts et les
  sondes. `scripts/check.ts` lance les 18 projets en parallèle (ils sont indépendants),
  en quelques secondes. `packages/desktop` et `website/` ont chacun leur propre `check`
  (Electrobun, `astro check`), absent de celui de la racine.
- `bun run lint` / `lint:fix` : Oxlint, avec TypeScript et règles React pertinentes, sur
  tout le dépôt sauf quatre fichiers de `packages/desktop` qui ont besoin des types
  d'Electrobun : le `check` de ce paquet les lint après `electrobun prepare`.
- `bun run format` / `format:check` : Oxfmt.
- `bun run verify` : types, lint, format, tests et build. Le contrôle complet, une fois,
  avant d'intégrer une branche.
- `bun run verify:fast [base]` : pendant qu'une modification se fait. Types, lint et
  format sur tout le dépôt (quelques secondes), puis seulement les tests que la
  modification peut atteindre depuis `base` (`main` par défaut) : ceux que
  `bun test --changed` trouve par les imports, plus ceux qui nomment
  `examples/<app>` quand l'application change et ceux qui lancent `cli.ts` quand la CLI
  change. Un changement de manifeste, de lockfile, de configuration TypeScript ou Bun,
  ou des helpers et fixtures des tests, relance toute la suite.

La CI (`.github/workflows/ci.yml`, GitHub Actions) tourne à chaque push et pull request.
Le job `verify`, sous macOS et Linux, enchaîne `bun install --frozen-lockfile`, la même
installation dans `website/` suivie de `astro sync` (le lint type-checke ses sources, qui
ont besoin des paquets d'Astro et des types générés dans `website/.astro`),
`bun run probes`, `bun run verify`, `test:pty`, `test:pty:dev` et
`scripts/clean-install.ts`, puis, sous Linux seulement, `scripts/linux-client.ts`. Le job
`linux-sandbox` vérifie que le lanceur versionné est celui que ses sources construisent
(`scripts/build-sandbox.ts --check`), puis lance `scripts/linux-sandbox.ts`. En local,
`bun run build:sandbox` et `bun run test:linux:sandbox` lancent ces deux scripts.

Le lint ne tolère aucun warning. Les seuls commentaires d’exception
(`typescript/triple-slash-reference`) incluent les déclarations ambiantes de Flight dans
les adapters ; il n’existe pas de désactivation globale des hooks.
Les dépendances des effets React, imports inutilisés et écritures pendant le rendu
signalés par Oxlint ont été corrigés.

Le handoff historique, les résultats bruts de sondes et la capture PTY ne sont pas
reformatés. Les sources des sondes sont couvertes par TypeScript et Oxlint, sauf
`probes/vt-embed` et `probes/devtools-tanstack` (chacune avec son propre `tsconfig.json`,
exclues du contrôle racine et du lint) et `probes/compile/wrapper.ts`, exclu du contrôle.

## VS Code

Ouvrir le dossier de ce projet comme racine VS Code pour appliquer
les réglages `.vscode/`. Installer les extensions recommandées **TypeScript 7** (`TypeScriptTeam.native-preview`)
et **Oxc**. Les réglages activent le serveur natif et sélectionnent `node_modules/typescript`.
Le SDK classique de repli pointe vers `node_modules/@typescript/old/lib`, fourni
par le paquet officiel de compatibilité TypeScript 6. Recharger la fenêtre si nécessaire.

L’extension recommandée est `oxc.oxc-vscode` ; elle utilise les binaires installés
localement. Le formatage à la sauvegarde utilise Oxfmt et les corrections explicites
à la sauvegarde utilisent Oxlint. Les autres IDE peuvent utiliser les mêmes
configurations via les outils CLI/LSP. Sources :
[Oxlint dans les éditeurs](https://oxc.rs/docs/guide/usage/linter/editors.html),
[Oxfmt dans les éditeurs](https://oxc.rs/docs/guide/usage/formatter/editors.html).

## Starters

`airtty init` génère une application depuis l'exemple Notes, avec les dépendances que
Notes déclare (versions du catalogue résolues), une dépendance locale `file:` vers
`packages/airtty`, sa configuration TypeScript héritée de `airtty/tsconfig`,
les configurations Oxc, les réglages VS Code et les commandes check/lint/format.
Après `bun install`, ces commandes fonctionnent depuis le starter. Les deux
fichiers JSON générés sont formatés par Oxfmt dès la création.

`scripts/clean-install.ts` vérifie depuis des dossiers temporaires une installation
neuve du framework et du starter, les types, le lint et le format du starter,
puis les artefacts séparés en PTY. Une sonde TypeScript y importe `node:path` et
utilise `process` : ses types sont résolus, et une affectation `process.pid` à une
chaîne est effectivement refusée. Le contrôle ne masque donc pas les erreurs.

## Versions et compatibilité

Le build importe explicitement `@typescript/typescript6`, car TypeScript 7 n’expose
plus l’ancienne API `createProgram`/`transpileModule`. Ce paquet dépend de
`@typescript/old`, qui déclare lui aussi un binaire `tsc` et gagne le lien
`node_modules/.bin/tsc` : un `tsc` nu lance donc le type-checker de TypeScript 6,
5 à 10 fois plus lent. `scripts/check.ts` appelle explicitement `typescript/bin/tsc`
(7.0.2) ; le paquet de compatibilité ne sert qu’à l’API AST du build.
Voir [la transition officielle](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
et [la configuration VS Code](https://marketplace.visualstudio.com/items?itemName=TypeScriptTeam.native-preview).

OpenTUI 0.5.12 déclare `react-reconciler ^0.33.0` ; le framework épingle 0.33.0,
sans override. L'ancien override vers 0.34.0 a été retiré : ce reconciler appelle une
méthode de host config absente d'OpenTUI à chaque commit de transition, chemin
emprunté par TanStack Router (`tests/renderer.test.tsx`). Ne pas remonter le
reconciler au-delà de la plage d'OpenTUI sans que ce test passe. Voir [le relevé des dépendances](DEPENDENCIES.md).
