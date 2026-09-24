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

Deux scénarios, sans rien modifier dans `src/` :

- **today** : ce que `src/` permet aujourd'hui. Chaque Application reçoit son propre
  `resolveModule` (comme le `createApp` généré par `src/build.ts`), les stubs d'actions
  passent par `actionReference` et le singleton `current` de `src/client.tsx`, chaque
  embed est un `Shell` (un keymap sur le renderer entier).
- **proposed** : le refactor de docs/EMBEDDING.md, bricolé hors de `src/` dans
  `../generic-client/host.tsx` : un résolveur aiguilleur par préfixe d'id, un
  `airtty/client` par origine dont `actionReference` vise l'Application de cette origine,
  un keymap par embed sur un hôte « sourd » quand l'embed n'a pas les touches, et une
  error boundary par embed.

## Assertions (toutes vertes)

| Scénario | Assertion                                                                                | Observé                                                                   |
| -------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| audit    | Les built-ins Node d'un bundle sont connus au build                                      | files : `crypto`, `fs/promises`, `path`, `url`                            |
| today    | La page de mdreader ne résout plus ses Client Components : le résolveur de files a gagné | écran d'erreur « Unknown module …/components/Reader.tsx »                 |
| today    | files, créée en dernier, s'affiche                                                       | oui                                                                       |
| today    | `watchLibrary()`, importée par mdreader, part par l'Application de files                 | requête `…/actions/library.ts#watchLibrary` vue par files                 |
| today    | `Ctrl+R`, lié par les deux, n'atteint que le keymap créé en dernier (files)              | mdreader 0 refresh, files 1                                               |
| today    | Keymaps non scopés : `[`, lié par mdreader seul, l'atteint quel que soit le panneau      | navigation de mdreader                                                    |
| today    | Un crash dans l'embed de files efface aussi mdreader                                     | seule l'erreur reste à l'écran (boundary racine d'OpenTUI)                |
| proposed | Les deux applications s'affichent côte à côte                                            | frame dans results.json                                                   |
| proposed | Les Server Functions importées par mdreader vont à son Server ; files n'en envoie aucune | `watchLibrary`, `listDocs` avec le préfixe de mdreader                    |
| proposed | `Ctrl+R` ne rafraîchit que l'embed actif, puis l'autre après bascule                     | mdreader +0 / files +1, puis l'inverse                                    |
| proposed | `]` n'atteint pas mdreader quand files a les touches, l'atteint après bascule            | oui                                                                       |
| proposed | Un crash dans l'embed de files laisse mdreader tourner                                   | « files crashed: host-injected crash » à droite, mdreader intact à gauche |

## Ce que le probe établit

1. **Résolveur.** Le codec Flight navigateur (`client.browser`) ignore toute table de
   modules par réponse (`bundlerConfig` à `null`) et appelle le global
   `__webpack_require__` ; les variantes `edge`/`node` acceptent une table mais pas de
   `callServer`. La résolution est **paresseuse** : `requireModule` s'exécute pendant le
   rendu React (`React.lazy`), pas au décodage. Un aiguillage par « réponse courante »
   est donc impossible ; seul l'id peut porter l'origine. Il la porte déjà : `src/build.ts`
   préfixe chaque id par le buildId. Un aiguilleur par préfixe suffit (≈ 10 lignes).
2. **`current`.** Les références reçues **par Flight** (props passées par une page
   Server) utilisent le `callServer` de la réponse, donc la bonne Application. Seules les
   Server Functions **importées** par un Client Component passent par `current` : dans
   un runtime partagé, elles partent vers la dernière Application construite. Un
   `airtty/client` par origine (ou un aiguillage par préfixe d'id d'action) corrige.
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
- Un id aiguillé par buildId suppose un buildId par origine montée. Deux origines
  servant le **même** build (staging et production) partageraient le préfixe : il faut
  alors un préfixe d'instance (voir docs/EMBEDDING.md, « royaume »).
- Pas de sessions (`restore.ts`/`session.ts`) par embed : `run()` n'est pas utilisé.
- Mode `inline` = aucune isolation : le code de files lit le disque dans le processus du
  Client. C'est voulu (code de confiance) et visible grâce à l'audit des built-ins.
