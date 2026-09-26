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

| Dépendance                      | Version        | Utilisée par                            |
| ------------------------------- | -------------- | --------------------------------------- |
| @sqlite.org/sqlite-wasm         | 3.53.4-build1  | framework, runtime navigateur           |
| @xterm/xterm / @xterm/addon-fit | 6.0.0 / 0.11.0 | framework, runtime navigateur ; desktop |
| @xterm/addon-webgl              | 0.19.0         | desktop                                 |
| electrobun                      | 2.0.1          | desktop                                 |
| marked                          | 17.0.1         | mdreader                                |
| sharp                           | 0.35.4         | files                                   |
| @anthropic-ai/claude-agent-sdk  | 0.3.283        | coder (couplé à Claude Code 2.1.283)    |

Les arguments de ligne de commande des applications (`airtty/args`, `src/args.ts`)
n'ajoutent aucune dépendance : le parseur est maison (~300 lignes), piloté par le Standard
Schema et le Standard JSON Schema que zod 4 implémente déjà. commander, citty et cac
n'ont pas d'intégration de schéma, `util.parseArgs` ne sait pas exprimer une option à
valeur facultative (`--resume [ID]`), clipanion est à l'abandon. Repli « acheter » :
cleye 2.7.0 (Standard Schema natif) ; évolution si des complétions shell sont voulues :
@optique/core. Comparatif : `docs/coder/research/cli-args-report.md`.

`@anthropic-ai/claude-agent-sdk` (exemple coder) : sa licence n'est **pas** OSI
(conditions commerciales d'Anthropic) ; l'exemple est personnel et non commercial. Le
SDK embarque Claude Code par paquets de plateforme (`optionalDependencies`, ~225 Mo) :
coder exécute toujours le `claude` de l'utilisateur (`pathToClaudeCodeExecutable`), donc
les `overrides` du `package.json` racine remplacent ces paquets par un paquet vide
(`examples/coder/vendor/no-bundled-claude`) : ils ne sont jamais installés, et un test
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

Zod 4.6.5 valide les données externes (variables d'environnement, `airtty.json`, JSON
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
