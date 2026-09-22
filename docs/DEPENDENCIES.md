# Dépendances — 22 septembre 2026

Les versions stables ont été comparées aux tags `latest` du registre npm, aux
versions PyPI et aux releases officielles des outils. Les versions expérimentales
et canary ne sont pas sélectionnées. Les manifests et lockfiles du framework et
des deux sondes sont à jour ; `bun outdated` ne signale aucune mise à jour.

| Dépendance                                   | Version  |
| -------------------------------------------- | -------- |
| Bun / @types/bun                             | 1.4.2    |
| @opentui/core / @opentui/react               | 0.5.12   |
| react / react-dom / react-server-dom-webpack | 19.3.0   |
| react-reconciler                             | 0.33.0   |
| @tanstack/react-router                       | 1.170.38 |
| @types/react / @types/react-dom              | 19.3.0   |
| typescript                                   | 7.0.2    |
| @typescript/typescript6                      | 6.0.2    |
| oxlint                                       | 1.85.0   |
| oxfmt                                        | 0.70.0   |
| Python (local et CI)                         | 3.14.7   |
| pyte                                         | 0.8.2    |
| wcwidth                                      | 0.8.4    |
| actions/checkout                             | v7.0.1   |
| actions/setup-python                         | v7.0.0   |
| oven-sh/setup-bun                            | v2.2.0   |

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

Une installation neuve signale encore un avertissement de peer dependency :
`bun-ffi-structs` 0.3.1, dépendance transitive d’OpenTUI, déclare `typescript ^5`.
Ses fichiers distribués n’importent pas le compilateur TypeScript ; les contrôles
TypeScript 7, le build et les parcours PTY passent. Cette plage amont reste à
actualiser : aucun patch local ne masque l’avertissement.

Les transitives ont été rafraîchies dans les plages autorisées par leurs packages
parents. Certaines versions plus anciennes peuvent rester imposées par ces derniers.
`bun audit --json` retourne `{}` pour les trois lockfiles : aucun avis connu
signalé au moment du contrôle.

Sources des outils : [Python](https://www.python.org/downloads/),
[pyte](https://pypi.org/project/pyte/), [wcwidth](https://pypi.org/project/wcwidth/),
[checkout](https://github.com/actions/checkout/releases/tag/v7.0.1),
[setup-python](https://github.com/actions/setup-python/releases/tag/v7.0.0),
[setup-bun](https://github.com/oven-sh/setup-bun/releases/tag/v2.2.0).
Les versions npm sont vérifiables avec `npm view <package> dist-tags.latest`.

La validation locale est décrite dans [VALIDATION.md](VALIDATION.md).
Le workflow GitHub macOS/Linux a été actualisé mais n’a pas encore été exécuté
sur GitHub.
