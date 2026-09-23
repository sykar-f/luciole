# TypeScript et Oxc

Le projet utilise TypeScript 7.0.2 pour les contrôles, `@typescript/typescript6` 6.0.2
pour l’API AST du build, `@types/bun` 1.4.2, Oxlint 1.85.0 (avec `oxlint-tsgolint` 7.0.2002
pour le lint type-aware) et Oxfmt 0.70.0.
Toutes ces versions sont fixées dans `package.json` et le lockfile.

`tsconfig.base.json` définit le mode strict, les types Bun (qui exposent aussi les
API Node), la résolution ESM Bundler et le JSX OpenTUI. `tsconfig.json` inclut le
framework, l’exemple, les tests, les scripts et les sondes. Les imports publics
`airtty/client` et `/server` passent par les exports du package :
aucun alias TypeScript ne masque une dépendance absente.

Le contrôle précédent ne couvrait que `src/` et l’exemple. Les tests/sondes pouvaient
être traités comme des fichiers sans configuration par VS Code, avec des erreurs
sur `node:*` et `process`. Étendre le contrôle a aussi révélé cinq erreurs réelles :
déclaration manquante du décodeur Flight Node, références Client typées comme
fonctions retournant `void`, appel spread d’une fonction typée et inference trop
large des fixtures. Elles sont corrigées sans `ts-ignore` ni désactivation du mode strict.

Flight n’expose pas de déclarations pour les entrées utilisées. `types.d.ts` contient
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
| Constantes nommées plutôt que valeurs magiques           | `no-magic-numbers` (hors tests)                                                                     |

Le lint type-aware utilise `oxlint-tsgolint` et les `tsconfig.json` du projet ; il ajoute
les règles de correction qui demandent des types (`await-thenable`, `no-floating-promises`,
`unbound-method`…). `no-magic-numbers` accepte -1, 0, 1, 2, les index et les valeurs par
défaut ; dans les tests, une valeur attendue écrite en clair reste plus lisible qu'une
constante. `examples/forge/server/ci.ts` et `seed.ts` en sont aussi exemptés : ce sont
des tables de données de démonstration (horaires du script CI simulé, jeu de données
généré), où nommer chaque valeur n'ajouterait aucun sens. `readonly` et `ReadonlyArray` pour les données immuables ne sont pas vérifiables
automatiquement sans bruit (`prefer-readonly-parameter-types` signale chaque paramètre
d'une bibliothèque) : ils restent une règle de revue.

Les données externes sont validées par Zod, à la frontière où elles entrent ; les données
internes gardent de simples types TypeScript.

## Commandes et CI

- `bun run check` : TypeScript, tous les fichiers du projet.
- `bun run lint` / `lint:fix` : Oxlint, avec TypeScript et règles React pertinentes.
- `bun run format` / `format:check` : Oxfmt.
- `bun run verify` : types, lint, format, tests et build ; même commande en CI.

Le lint ne tolère aucun warning. Les seuls commentaires d’exception ciblent le
registre singleton nécessaire aux proxies Flight et l’inclusion des déclarations
ambiantes dans les adapters ; il n’existe pas de désactivation globale des hooks.
Les dépendances des effets React, imports inutilisés et écritures pendant le rendu
signalés par Oxlint ont été corrigés.

Le handoff historique, les résultats bruts de sondes et la capture PTY ne sont pas
reformatés. Les sources des sondes sont bien couvertes par TypeScript et Oxlint.

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

`airtty init` génère une application avec une dépendance locale `file:` vers ce
framework, sa configuration TypeScript héritée de `airtty/tsconfig`,
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
plus l’ancienne API `createProgram`/`transpileModule`. Les commandes `tsc` utilisent
bien 7.0.2 ; le paquet de compatibilité n’est pas un maintien du type-checker en 5.x.
Voir [la transition officielle](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
et [la configuration VS Code](https://marketplace.visualstudio.com/items?itemName=TypeScriptTeam.native-preview).

OpenTUI 0.5.12 déclare `react-reconciler ^0.33.0` ; le framework épingle 0.33.0,
sans override. L'ancien override vers 0.34.0 a été retiré : ce reconciler appelle une
méthode de host config absente d'OpenTUI à chaque commit de transition, chemin
emprunté par TanStack Router (`tests/renderer.test.tsx`). Ne pas remonter le
reconciler au-delà de la plage d'OpenTUI sans que ce test passe. Voir [le relevé des dépendances](DEPENDENCIES.md).
