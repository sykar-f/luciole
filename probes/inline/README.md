# Deux applications inline dans un même Client

Exécuté avec succès le 24 septembre 2026, macOS 26.6.2 (arm64), Bun 1.4.2, depuis la
racine du dépôt :

```sh
bun probes/inline/probe.tsx     # écrit results.json à côté
```

Deux vraies applications du dépôt, `examples/mdreader` et `examples/files`, chacune avec
son Server (processus séparés), montées côte à côte dans **un** processus, **un** arbre
React et **un** renderer OpenTUI. Toutes deux importent des Server Functions depuis des
Client Components (`useLive(watchLibrary)` pour mdreader, `preview`/`thumbnail` pour
files) et lient `Ctrl+R` globalement. Les bundles sont ceux de
[generic-client](../generic-client/README.md) (runtime partagé), chargés depuis la
mémoire, sans réseau.

Les Servers sont lancés par `instance-server.ts`, qui émule le changement proposé dans
`src/server.ts` (décision 4 de docs/EMBEDDING.md) : une requête portant
`x-airtty-instance: <clé>` reçoit des Client References écrites
`<clé>@<buildId>/<chemin>` ; sans l'en-tête, les ids sont ceux d'aujourd'hui. Un second
Server de mdreader, avec d'autres documents, représente deux panes de la même application.

Scénarios, sans rien modifier dans `src/` :

- **today** : ce que `src/` permet aujourd'hui. Chaque Application reçoit son propre
  `resolveModule` (comme le `createApp` généré par `src/build.ts`), les stubs d'actions
  passent par `actionReference` et le singleton `current` de `src/client.tsx`, chaque
  embed est un `Shell` (un keymap sur le renderer entier).
- **proposed** : le refactor de docs/EMBEDDING.md, bricolé hors de `src/` dans
  `../generic-client/host.tsx` (`createPanes`) : un résolveur aiguilleur par préfixe
  d'instance, un `airtty/client` par pane dont `actionReference` vise l'Application de ce
  pane, un keymap par embed sur un hôte « sourd » quand l'embed n'a pas les touches, et
  une error boundary par embed.
- **panes/build** puis **panes/instance** : deux panes de mdreader (même build), chacun
  contre son Server, aiguillés d'abord par buildId (sans changement du Server), puis par
  instance.

## Assertions (toutes vertes)

| Scénario       | Assertion                                                                                | Observé                                                                   |
| -------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| audit          | Les built-ins Node d'un bundle sont connus au build                                      | files : `crypto`, `fs/promises`, `path`, `url`                            |
| today          | La page de mdreader ne résout plus ses Client Components : le résolveur de files a gagné | écran d'erreur « Unknown module …/components/Reader.tsx »                 |
| today          | files, créée en dernier, s'affiche                                                       | oui                                                                       |
| today          | `watchLibrary()`, importée par mdreader, part par l'Application de files                 | requête `…/actions/library.ts#watchLibrary` vue par files                 |
| today          | `Ctrl+R`, lié par les deux, n'atteint que le keymap créé en dernier (files)              | mdreader 0 refresh, files 1                                               |
| today          | Keymaps non scopés : `[`, lié par mdreader seul, l'atteint quel que soit le panneau      | navigation de mdreader                                                    |
| today          | Un crash dans l'embed de files efface aussi mdreader                                     | seule l'erreur reste à l'écran (boundary racine d'OpenTUI)                |
| proposed       | Les deux applications s'affichent côte à côte                                            | frame dans results.json                                                   |
| proposed       | Les Server Functions importées par mdreader vont à son Server ; files n'en envoie aucune | `watchLibrary`, `listDocs` avec le préfixe de mdreader                    |
| proposed       | `Ctrl+R` ne rafraîchit que l'embed actif, puis l'autre après bascule                     | mdreader +0 / files +1, puis l'inverse                                    |
| proposed       | `]` n'atteint pas mdreader quand files a les touches, l'atteint après bascule            | oui                                                                       |
| proposed       | Un crash dans l'embed de files laisse mdreader tourner                                   | « files crashed: host-injected crash » à droite, mdreader intact à gauche |
| panes/build    | Les Client References du pane a sont résolues avec l'instance de modules du pane b       | pane a 0 résolution, pane b 2                                             |
| panes/build    | Les Server Functions importées par le pane a partent par l'Application du pane b         | pane a 0 action, pane b 4                                                 |
| panes/instance | Chaque pane affiche le document de son Server                                            | oui                                                                       |
| panes/instance | Chaque pane résout avec sa propre instance de modules                                    | 1 et 1                                                                    |
| panes/instance | Chaque pane envoie ses Server Functions importées par sa propre Application              | 2 et 2                                                                    |

## Ce que le probe établit

1. **Résolveur.** Le codec Flight navigateur (`client.browser`) ignore toute table de
   modules par réponse (`bundlerConfig` à `null`) et appelle le global
   `__webpack_require__` ; les variantes `edge`/`node` acceptent une table mais pas de
   `callServer`. La résolution est **paresseuse** : `requireModule` s'exécute pendant le
   rendu React (`React.lazy`), pas au décodage. Un aiguillage par « réponse courante »
   est donc impossible ; seul l'id peut porter le pane. Le buildId que `src/build.ts` met
   déjà en tête de chaque id ne suffit pas : deux panes du même build partagent alors
   modules et Application (panes/build). Le Server doit écrire la clé d'instance que le
   Client lui envoie ; Flight lit `manifest[id].id` pour chaque référence, donc une copie
   préfixée du manifeste par instance suffit (`instance-server.ts`).
2. **`current`.** Les références reçues **par Flight** (props passées par une page
   Server) utilisent le `callServer` de la réponse, donc la bonne Application. Seules les
   Server Functions **importées** par un Client Component passent par `current` : dans
   un runtime partagé, elles partent vers la dernière Application construite. Un
   `airtty/client` par pane, lié à l'évaluation du bundle de ce pane, corrige ; les ids
   d'action, eux, restent ceux du build (le Server les connaît ainsi).
3. **Clavier.** Chaque `Shell` crée un keymap global sur le renderer. Le dernier créé
   passe en premier (`prependListener`) et consomme les touches qu'il lie ; les autres
   touches tombent dans les keymaps précédents. Il faut un keymap par embed dont l'hôte
   n'écoute que lorsque l'embed a les touches ; les couches `focus`/`focus-within` des
   applications continuent de fonctionner.
4. **Crash.** `createRoot` d'OpenTUI pose une boundary à la racine : sans boundary par
   embed, une erreur de rendu dans une application remplace tout l'écran.

## Mesures

Évaluer et monter une application (bundle déjà en mémoire) : ≈ 1 ms la première, ≈ 0,6 ms
la seconde. RSS avant rendu 625 Mo (processus de probe : builds, TypeScript), après rendu
des deux applications 657 Mo (+32 Mo, buffers du renderer de test compris). Aucun
processus supplémentaire côté Client.

## Limites

- Le focus OpenTUI reste global : un `<input focused>` d'un embed inactif recevrait
  encore la frappe (le renderer route les touches au renderable focalisé, hors keymap).
  Aucune des deux applications n'avait de champ focalisé au moment de la mesure
  (`focusedAfterMount: null`) ; l'hôte doit retirer le focus en basculant (à faire).
- `instance-server.ts` patche `Bun.serve` et `renderToPipeableStream` dans le processus
  du Server avant de le charger : c'est une émulation. Dans `src/server.ts`, ce sont
  quelques lignes autour de `renderToReadableStream(tree, config.manifest)`.
- Pas de sessions (`restore.ts`/`session.ts`) par embed : `run()` n'est pas utilisé.
- Mode `inline` = aucune isolation : le code de files lit le disque dans le processus du
  Client. C'est voulu (code de confiance) et visible grâce à l'audit des built-ins.
