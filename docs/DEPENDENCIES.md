# Dépendances — 22 septembre 2026

Les versions stables ont été comparées aux tags `latest` du registre npm, aux
versions PyPI et aux releases officielles des outils. Les versions expérimentales
et canary ne sont pas sélectionnées. Les manifests et lockfiles du framework et
des deux sondes d'origine (`probes/rsc`, `probes/rpc`) étaient à jour ; `bun outdated` ne signalait aucune mise à jour.

| Dépendance                                   | Version  |
| -------------------------------------------- | -------- |
| Bun / @types/bun                             | 1.4.2    |
| @opentui/core / @opentui/react               | 0.5.12   |
| @opentui/keymap                              | 0.5.12   |
| react / react-dom / react-server-dom-webpack | 19.3.0   |
| react-reconciler                             | 0.33.0   |
| @tanstack/react-router                       | 1.170.38 |
| @tanstack/react-form (exemples)              | 1.33.5   |
| @types/react / @types/react-dom              | 19.3.0   |
| typescript                                   | 7.0.2    |
| @typescript/typescript6                      | 6.0.2    |
| oxlint                                       | 1.85.0   |
| oxlint-tsgolint                              | 7.0.2002 |
| oxfmt                                        | 0.70.0   |
| zod                                          | 4.6.5    |
| actions/checkout                             | v7.0.1   |
| oven-sh/setup-bun                            | v2.2.0   |

Ajoutées au catalogue après ce contrôle, sans comparaison aux tags `latest` :

| Dépendance                                     | Version                  | Utilisée par                            |
| ---------------------------------------------- | ------------------------ | --------------------------------------- |
| @sqlite.org/sqlite-wasm                        | 3.53.4-build1            | framework, runtime navigateur           |
| @xterm/xterm / @xterm/addon-fit                | 6.0.0 / 0.11.0           | framework, runtime navigateur ; desktop |
| @xterm/addon-webgl                             | 0.19.0                   | desktop                                 |
| electrobun                                     | 2.0.1                    | desktop                                 |
| marked                                         | 17.0.1                   | framework (`<Markdown>`), mdreader      |
| sharp                                          | 0.35.4                   | files                                   |
| tree-sitter-bash / -c / -cpp                   | 0.25.1 / 0.24.1 / 0.23.4 | framework (`luciole/grammars`)          |
| tree-sitter-css / -go / -html                  | 0.25.0 / 0.25.0 / 0.23.2 | framework (`luciole/grammars`)          |
| tree-sitter-java / -json / -php                | 0.23.5 / 0.24.8 / 0.24.2 | framework (`luciole/grammars`)          |
| tree-sitter-python / -ruby                     | 0.25.0 / 0.23.1          | framework (`luciole/grammars`)          |
| tree-sitter-rust                               | 0.24.0                   | framework (`luciole/grammars`)          |
| @tree-sitter-grammars/tree-sitter-toml / -yaml | 0.7.0 / 0.7.1            | framework (`luciole/grammars`)          |
| @anthropic-ai/claude-agent-sdk                 | 0.3.283                  | harness (couplé à Claude Code 2.1.283)  |

Les grammaires Tree-sitter (`luciole/grammars`, licence MIT) sont les paquets officiels :
chacun livre son WebAssembly et ses requêtes de coloration à la même version. Seul le
WebAssembly sert ; leurs liaisons natives ne sont jamais construites (Bun bloque leurs
scripts `install`, `bun pm untrusted` les liste) et leurs dépendances `node-addon-api` et
`node-gyp-build` restent inutilisées. `bun audit --json` rend `{}`. Il n'existe pas de
paquet npm avec le WebAssembly de diff ni de SQL : les blocs diff sont colorés sans
grammaire, SQL reste en texte brut.

Les arguments de ligne de commande des applications (`luciole/args`, `src/args.ts`)
n'ajoutent aucune dépendance : le parseur est maison (~300 lignes), piloté par le Standard
Schema et le Standard JSON Schema que zod 4 implémente déjà. commander, citty et cac
n'ont pas d'intégration de schéma, `util.parseArgs` ne sait pas exprimer une option à
valeur facultative (`--resume [ID]`), clipanion est à l'abandon. Repli « acheter » :
cleye 2.7.0 (Standard Schema natif) ; évolution si des complétions shell sont voulues :
@optique/core. Comparatif : `docs/coder/research/cli-args-report.md`.

`@anthropic-ai/claude-agent-sdk` (paquet `packages/harness`, utilisé par coder et studio) : sa licence n'est **pas** OSI
(conditions commerciales d'Anthropic) ; l'exemple est personnel et non commercial. Le
SDK embarque Claude Code par paquets de plateforme (`optionalDependencies`, ~225 Mo) :
coder exécute toujours le `claude` de l'utilisateur (`pathToClaudeCodeExecutable`), donc
les `overrides` du `package.json` racine remplacent ces paquets par un paquet vide
(`packages/harness/vendor/no-bundled-claude`) : ils ne sont jamais installés, et un test
vérifie qu'ils ne se résolvent pas. Ses pairs `@anthropic-ai/sdk` et
`@modelcontextprotocol/sdk` sont installés par Bun comme dépendances transitives ;
`bun audit --json` rend `{}`.

TypeScript 7 vérifie le projet. Le compilateur du framework utilise le paquet
officiel de compatibilité `@typescript/typescript6`, qui fournit l’ancienne API AST
et résout actuellement TypeScript 6.0.3 via `@typescript/old`. Cette séparation est
nécessaire car TypeScript 7 ne fournit pas cette API ; voir
[l’annonce officielle](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/).
Les réglages VS Code activent le serveur natif avec l’extension recommandée et
conservent un SDK classique de repli ; voir [TOOLING.md](TOOLING.md).

`react-reconciler` est épinglé à 0.33.0, dans la plage `^0.33.0` déclarée par
OpenTUI 0.5.12 ; sa `peerDependency` `react ^19.2.0` accepte React 19.3.0. Un
override vers 0.34.0 a existé : il a été retiré, car ce reconciler appelle
`suspendOnActiveViewTransition` à chaque commit de transition, méthode absente du host
config d'OpenTUI, ce qui faisait planter les navigations TanStack en production.
`tests/renderer.test.tsx` protège ce point ; un test vérifie aussi la version
réellement résolue par OpenTUI et l'unicité de React et Core.

TanStack Router est épinglé exactement ; seul `@tanstack/react-router` est déclaré,
ses paquets `router-core`, `history` et `react-store` sont des transitives du
lockfile. Il est embarqué dans le bundle Client (voir [ROUTER.md](ROUTER.md)).

TanStack Form 1.33.5 est une dépendance de Forge seul : le framework ne l'importe
pas, le formulaire de nouvelle pull request de Forge l'utilise pour montrer qu'une
bibliothèque de formulaires s'utilise telle quelle avec `Input`, `Textarea` et
`useRestoredFields` (voir [API.md](API.md)). Il partage `@tanstack/store` 0.11.1 avec le
Router : une seule copie dans le lockfile. Un starter reçoit les dépendances de Notes et
l'outillage du framework : ni TanStack Form, ni `marked` (mdreader), ni `sharp` (files).

Zod 4.6.5 valide les données externes (variables d'environnement, `luciole.json`, JSON
lu sur disque, requêtes reçues par le Server, enveloppes reçues par le Client). Le
bundle Client n'embarque que `zod/mini`, l'API fonctionnelle tree-shakable de la même
version : mesuré isolément sur un schéma d'enveloppe, `zod/mini` ajoute 28 Ko non
minifiés, contre 156 Ko pour l'API classique. Au moment de la mesure, avec tous les schémas
du Client, le bundle complet de Notes passait de 415 à 460 Ko ([VALIDATION.md](VALIDATION.md)), sans différence
de démarrage mesurable. Le Server, le build et les tests utilisent l'API classique.

`oxlint-tsgolint` fournit à Oxlint les informations de types (`options.typeAware`) :
sans lui, une valeur `any` issue de `JSON.parse`, de `.json()` ou d'un décodage ne serait
signalée nulle part. Sa version suit celle de TypeScript 7 (voir [TOOLING.md](TOOLING.md)).

Une installation neuve signale encore un avertissement de peer dependency :
`bun-ffi-structs` 0.3.1, dépendance transitive d’OpenTUI, déclare `typescript ^5`.
Ses fichiers distribués n’importent pas le compilateur TypeScript ; les contrôles
TypeScript 7, le build et les parcours PTY passent. Cette plage amont reste à
actualiser : aucun patch local ne masque l’avertissement.

Les transitives ont été rafraîchies dans les plages autorisées par leurs packages
parents. Certaines versions plus anciennes peuvent rester imposées par ces derniers.
`bun audit --json` retournait `{}` pour le lockfile racine et ceux des deux sondes
d'origine : aucun avis connu signalé au moment du contrôle. Les autres sondes et
`website/` ont leur propre lockfile, hors de ce contrôle.

Sources des outils : [checkout](https://github.com/actions/checkout/releases/tag/v7.0.1),
[setup-bun](https://github.com/oven-sh/setup-bun/releases/tag/v2.2.0).
Les versions npm sont vérifiables avec `npm view <package> dist-tags.latest`.

La validation locale est décrite dans [VALIDATION.md](VALIDATION.md).
Le workflow macOS/Linux s’exécute sur GitHub Actions à chaque push et pull request.

## Licences

`bun run licenses` (`scripts/licenses.ts`) lit les `package.json` installés et vérifie
l'arbre de production (dépendances, optionnelles, pairs résolus) de `luciole`,
`@luciole/flow` et `@luciole/editor`. Il échoue dès qu'un paquet livré porte une licence
bloquante (GPL, AGPL, SSPL, absente, « SEE LICENSE IN »). Les espaces de travail privés
(`harness`, `desktop`, `examples/*`) sont listés à part et n'échouent jamais.

Résultat du 1er octobre 2026 : 137, 23 et 22 paquets, tous permissifs (MIT, Apache-2.0,
BSD-3-Clause, Unlicense), sauf une licence non permissive dans l'arbre livré :

| Licence | Paquet              | Livré par | Pourquoi c'est acceptable                                                                                                                                                                                                                                  |
| ------- | ------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MPL-2.0 | `@resvg/resvg-wasm` | `luciole` | Copyleft faible, au niveau du fichier : le paquet est utilisé tel quel, sans modification, et n'impose rien au code MIT de luciole. L'obligation (avis de licence et accès au source) est remplie par [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). |

Le script ne lit que ce qui est installé : les dépendances optionnelles d'autres plateformes
(binaires `@opentui/core-linux-*`, `@typescript/typescript-*`) sont listées comme absentes et
leur licence n'est pas lue ; une dépendance requise qui ne se résout pas fait échouer le
contrôle. À relancer sous Linux quand la CI le branchera.

Hors de ce qui est livré, deux licences non permissives apparaissent, et le script les
signale comme « non livrées » :

| Licence                        | Paquet                                        | Utilisé par                                                    | Pourquoi ce n'est pas livré                                                                                                              |
| ------------------------------ | --------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| LGPL-3.0-or-later              | `@img/sharp-libvips-*` (libvips, via `sharp`) | `examples/files` et `devDependencies` du paquet racine (privé) | `sharp` n'est une dépendance d'aucun paquet livré ; un exemple ne se publie pas. À revoir si `sharp` entre un jour dans un paquet livré. |
| propriétaire (« SEE LICENSE ») | `@anthropic-ai/claude-agent-sdk`              | `@luciole/harness` (privé), exemples                           | Le harnais est privé et n'est pas publié ; le SDK n'est redistribué avec aucun paquet livré.                                             |

## Ce que `luciole` installe (`packages/luciole/package.json`)

Installer `luciole` n'installe que ce que toute application utilise. Les plages publiées
sont en `^` ; le catalogue du dépôt et les `devDependencies` gardent les versions exactes,
pour que le dépôt reste reproductible.

| Dépendance                                        | Classe                  | Avant → après               | Raison                                                                                                                                             |
| ------------------------------------------------- | ----------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| @opentui/core, keymap, react                      | toute application       | exact → `^`                 | Le moteur de rendu : chaque application l'utilise.                                                                                                 |
| @tanstack/react-router, react-reconciler          | toute application       | exact → `^`                 | Routeur et réconciliateur de chaque application.                                                                                                   |
| react-server-dom-webpack, zod                     | toute application       | exact → `^`                 | Flight (RSC) et schémas des actions et des arguments.                                                                                              |
| marked                                            | toute application       | exact → `^`                 | `<Markdown>` fait partie du client ; il n'est pas chargé à la demande.                                                                             |
| @typescript/typescript6                           | outil du build, runtime | exact → `^`                 | `luciole build` lit l'AST de l'application avec cette API (`build.ts`, cache, contexte asynchrone) : il lui faut à l'exécution.                    |
| typescript (7)                                    | outil de l'application  | dependency → devDependency  | Aucun module de `luciole` ne l'importe : seul `tsc --noEmit` l'utilise, et `luciole init` le range déjà dans les devDependencies de l'application. |
| tree-sitter-\* (13), @tree-sitter-grammars/\* (3) | optionnelle             | dependency → peer optionnel | Servent à `luciole/grammars` seul, que l'application importe ou non.                                                                               |
| mathjax-full, @resvg/resvg-wasm                   | optionnelle             | dependency → peer optionnel | Servent à `luciole/math` seul (quelques mégaoctets de WebAssembly).                                                                                |
| @sqlite.org/sqlite-wasm                           | optionnelle             | dependency → peer optionnel | Le Worker de la cible web (`--web=local`) l'embarque ; le cache serveur utilise `bun:sqlite` et n'en dépend pas.                                   |
| @xterm/xterm, addon-fit, addon-webgl              | optionnelle             | dependency → peer optionnel | Le runtime de la cible web les bundle ; aucune autre cible n'y touche.                                                                             |

Une fonctionnalité optionnelle sans son paquet échoue avec un message qui le nomme
(`luciole/math needs the optional package mathjax-full, which is not installed: run
\`bun add mathjax-full\``) : `src/optional.ts`. `luciole/math`et`luciole/grammars`chargent leurs paquets par`import()`dynamique, à la première formule ou à l'import du
module ; les builds web vérifient les leurs avant d'empaqueter. Le dépôt garde ces paquets
en`devDependencies`de`luciole`pour que les exemples et les tests les trouvent ;`luciole init`les range dans les`devDependencies` de l'application créée.
