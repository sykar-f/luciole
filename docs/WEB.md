# Étude — cible web : le Client (et le Server) dans un navigateur

> **Statut : étapes 0 à 4 faites** (§ 5) : le Client web tourne contre un vrai Server
> (`--web`), l'application entière dans un site statique (`--web-local`), et la landing
> (`website/`) ouvre Notes ainsi. Reste le shell hébergé ailleurs (étape 5).

## Décision proposée

Le navigateur devient un **hôte** de plus, au même titre que le Client générique
([EMBEDDING.md](EMBEDDING.md)) : il évalue le bundle d'application `.airtty/app/index.cjs`
**inchangé** contre un runtime web qui satisfait la même ABI (`src/abi.ts`). Aucun
nouveau format de build pour le code Client d'une application.

Les deux formes demandées ne diffèrent que par le `fetch` donné à l'`Application`
(`ApplicationOptions.fetch`, déjà là) :

| Forme                       | `fetch` de l'Application                         | Le Server                                         | Pour                                    |
| --------------------------- | ------------------------------------------------ | ------------------------------------------------- | --------------------------------------- |
| **Client web**              | `window.fetch` vers un vrai Server               | le Server habituel (Bun), qui sert aussi le shell | ouvrir une app hébergée depuis un lien  |
| **Tout dans le navigateur** | un `fetch` vers un Web Worker, par `postMessage` | le même handler, bundlé pour le navigateur        | démo de la landing, app hors ligne, PWA |

Il n'y a pas de Bun dans le navigateur : le code JS d'airtty tourne sur le moteur de la
page, les API Bun et Node sont remplacées par des modules de plateforme. Seul le cœur Zig
d'OpenTUI passe en WebAssembly.

```text
                 navigateur (une origine)
┌───────────────────────────────────────────────────────────────────────────┐
│ page                                                                      │
│  ┌─────────────┐  ANSI   ┌────────────────────────────────────────────┐   │
│  │  xterm.js   │ ◀────── │ runtime web (build du framework, par ABI)  │   │
│  │             │ ──────▶ │  React, TanStack, keymap, airtty/client    │   │
│  └─────────────┘ touches │  @opentui/core + FfiBackend WASM           │   │
│                          │  bundle d'app évalué (.airtty/app)         │   │
│                          └──────────────┬─────────────────────────────┘   │
│                                         │ fetch(Request) → Response        │
│              ┌──────────────────────────┴───────────┐                      │
│              ▼ tout dans le navigateur              ▼ Client web           │
│  ┌─────────────────────────────────┐        réseau HTTPS vers le Server    │
│  │ Worker : createHandler(config)  │        (qui sert /manifest, /bundle,  │
│  │ bundle Server « web », SQLite   │         et le shell web)              │
│  │ WASM (OPFS)                     │                                       │
│  └─────────────────────────────────┘                                       │
└───────────────────────────────────────────────────────────────────────────┘
```

## Mode d'emploi (Client web)

```sh
ZIG=/chemin/zig-0.16.0 airtty web-runtime        # une fois par ABI et framework : ~30 s, réseau
airtty build --web                                # .airtty/web/ à côté de server/, client/, app/
AIRTTY_WEB_ORIGIN=https://notes.example.com PORT=3000 bun --conditions=react-server .airtty/server/index.js
```

Le navigateur ouvre `https://notes.example.com/` et arrive sur `/_airtty/web/`. Le runtime
est dans `$XDG_CACHE_HOME/airtty/web/<clé d'ABI>-<hash du framework>/` : la page est
aussi du code du framework. `airtty build --web` le prépare s'il manque. En local : `AIRTTY_WEB_ORIGIN=http://127.0.0.1:3000`.

| Fichier                             | Rôle                                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| `src/web-runtime.ts`                | Préparation par clé d'ABI : OpenTUI au tag de l'ABI, patch, Zig, bundle ; copie    |
| `src/web-routes.ts`                 | `/_airtty/web/*` et l'origine déclarée (`Origin` et `Host`)                        |
| `src/web/build.ts`                  | Bundle de la page : variantes, OpenTUI depuis ses sources, shims Node, clé d'ABI   |
| `src/web/platform/`                 | Variantes : `run`, `app-bundle`, `host-direct`, `vt/terminal`, `flight/server`     |
| `src/web/opentui/`, `src/web/node/` | Backend FFI WASM d'OpenTUI, Worker tree-sitter ; built-ins Node d'une page         |
| `web/opentui-v0.5.12.patch`         | Le patch natif d'OpenTUI (cible wasm32-wasi)                                       |
| `scripts/web/`                      | Driver CDP et parcours navigateur (`test:web`, `test:web:local`, `test:web:forge`) |

## Mode d'emploi (tout dans le navigateur)

```sh
airtty build --web-local          # .airtty/web/ : page, runtime, server-worker.js, sqlite3.wasm, app/
```

`.airtty/web/` se sert tel quel par n'importe quel hébergement statique (`application/wasm`
pour les `.wasm`). La page charge le bundle d'app depuis `app/` et ouvre un SharedWorker
nommé comme l'app (`server-worker.js`) : l'entrée Server générée, bundlée pour le
navigateur, dont `serve()` répond aux onglets par `MessagePort`. Les bases SQLite vivent en
mémoire (SQLite WASM) et sont écrites dans OPFS (`airtty/<app>/`) après chaque Server
Function, avant sa réponse.

| Fichier                                | Rôle                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/build.ts` (rôle `web-server`)     | Même entrée et mêmes réécritures que le Server ; cible navigateur ; transformation async  |
| `src/web/server-build.ts`              | Plugins du rôle, amorçage, `sqlite3.wasm` à côté                                          |
| `src/web/server/`                      | Accueil des onglets, amorçage, protocole, côté Worker et côté page, instantanés OPFS      |
| `src/web/platform/serve.ts`            | `serve()` du Worker : `createHandler`, persistance après chaque action                    |
| `src/web/async-context/`               | `AsyncLocalStorage` et transformation des `await` (R2)                                    |
| `src/web/node/bun-sqlite.ts`, `bun.ts` | `bun:sqlite` sur SQLite WASM (parité testée) ; `Bun.sleep`, `env`, `nanoseconds`, SHA-256 |

Ce que le code Server d'une app peut utiliser ici : `bun:sqlite` (le sous-ensemble ci-dessus),
`Bun.sleep`, `crypto`, `fetch` vers la même origine, un SHA-256 synchrone
(`Bun.CryptoHasher("sha256")`, `createHash("sha256")`, `node/sha256.ts`) et l'encodage
`base64url` de `Buffer`, que le polyfill de Bun n'a pas (`node/buffer-base64url.ts`). `fs`,
`child_process`, `Bun.spawn`, `Bun.Terminal` échouent à l'usage avec un message ; ces apps
gardent `--web`.

Côté Client, la page fournit aussi au bundle d'app les built-ins Node qu'il déclare
(`child_process`, `fs`, `fs/promises`, `os`, `path`) : les mêmes remplaçants que ceux
d'OpenTUI, qui échouent à l'usage. Une app dont une fonction réservée au terminal importe
`child_process` (l'éditeur de Forge, touche `e`) s'ouvre donc, sans cette fonction.

## 1. Ce que l'architecture offre déjà

| Couture existante                              | Ce qu'elle rend possible                                                      |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `.airtty/app/` + ABI (`src/abi.ts`)            | le code Client d'une app, sans runtime, évaluable par n'importe quel hôte     |
| `ApplicationOptions.fetch` / `transport`       | brancher le Client sur un Worker au lieu du réseau, sans toucher au transport |
| `GET /manifest`, `GET /bundle/<sha256>`        | un Client web obtient le bundle d'une app depuis son Server                   |
| `HostChannel` (`src/host.ts`)                  | presse-papiers, ouverture d'URL, notifications par les API du navigateur      |
| `ApplicationOptions.session`, `quitOnCtrlC`    | session restaurée fournie par l'hôte ; Ctrl+C à l'app, comme en desktop       |
| `serve()` construit un `fetch(req)` standard   | le même handler dans un Worker, une fois séparé de `Bun.serve`                |
| `FfiBackend` d'OpenTUI (`platform/ffi`)        | un troisième backend, adossé à une instance WebAssembly                       |
| `createCliRenderer({ stdin, stdout })`         | sortie ANSI vers un émulateur web, clavier depuis lui                         |
| `airtty.capabilities` + built-ins du manifeste | refuser avant évaluation une app qui exige `fs`, `exec`, `pty`                |
| Contrat `AIRTTY_DESKTOP` (DESKTOP.md)          | déjà un hôte « fenêtre » avec xterm.js ; mêmes gestes, même vue               |

## 2. Obstacles dans `src/` et refactors faits

Chaque refactor a d'abord été fait **à comportement constant** pour le terminal, vérifié
par les tests et parcours PTY existants, avant qu'une ligne web n'existe.

**Variantes de plateforme.** Un module lié à Bun ou Node qui a un équivalent navigateur
garde son nom et reçoit, au même chemin sous `src/web/platform/`, une variante aux mêmes
exports ; le build navigateur la prend (`src/web/platform.ts`), le reste du code ne sait
rien. Sous `src/web/`, un `tsconfig` avec le DOM, que le reste du package n'a pas. Après
l'étape 3 : `run.tsx`, `host-direct.ts`, `app-bundle.ts`, `vt/terminal.tsx`,
`flight/server.ts`, `serve.ts`. `client.tsx`, le transport, `host.ts` et `app-evaluate.ts`
sont neutres.

### W1. `run()` mélangeait l'Application et la plateforme terminal

`client.tsx` importait `connect`, `session`, lisait `process.env`, écoutait les signaux
et `process.on("message")`, créait le renderer sur le TTY.

**Fait** : `run()` vit dans `src/run.tsx` (réexporté par `airtty/client`) ; `client.tsx`
n'importe plus rien de Node. Sa variante `src/web/platform/run.tsx` exporte le même
`run()`, qui monte xterm.js sur `#airtty`, et `runInPage(create, { element, server,
fetch, name, sessionKey })` pour une page qui choisit son élément et son `fetch`.

### W2. `serve()` liait le handler à `Bun.serve`

**Fait** : `createHandler(config, options)` (`src/server.ts`) porte auth, routes,
actions, Flight, cache et instrumentation ; `serve()` (`src/serve.ts`) y ajoute
l'environnement, `Bun.serve`, le socket et le cycle de vie. La variante
`src/web/platform/serve.ts` appelle `createHandler` et répond aux onglets par
`MessagePort` ; les corps restent des `ReadableStream`, donc le live et le streaming
Flight passent tels quels.

### W3. `loadAppBundle` lisait le disque et évaluait par `node:vm`

**Fait** : `evaluateAppBundle(evaluation)` (`src/app-evaluate.ts`) vérifie et évalue ;
la table `RUNTIME` de l'ABI y vit, partagée par les deux runtimes. Le terminal lit le
disque et compile par `node:vm` (`src/app-bundle.ts`) ; le web lit par `fetch`, hache par
`crypto.subtle` et évalue par un `import()` de module `Blob`.

### W4. Session et hôte supposaient le système de fichiers et des binaires

**Fait** : `SessionStore` (`src/session.ts`) garde le fichier XDG du terminal ; la page
range sa session dans `localStorage`, par nom d'app et Server. `performDirectly`
(`src/host-direct.ts` : `pbcopy`, `open`…) a sa variante web, qui répond par
`navigator.clipboard`, `window.open` et `Notification` ; une page n'a pas de trousseau.

### W5. Flight côté Server passait par `node:stream`

`src/flight/server.ts` convertit un `PassThrough`. Sa variante
`src/web/platform/flight/server.ts` offre les mêmes exports sur
`react-server-dom-webpack/server.edge` (flux web), aux mêmes digests. Le Server Bun garde
l'entrée Node : l'entrée edge n'active le stockage par requête de React (`React.cache`)
qu'avec un `AsyncLocalStorage` **global**, que Bun n'a pas ; le Worker web le fournit
(W6).

### W6. Le contexte de requête repose sur `AsyncLocalStorage`

Trois magasins : le contexte de requête (`server.ts` : session, callId, invalidations),
`cacheScope` et `renderTags` (`src/cache/scope.ts`). Ils doivent survivre aux `await`
des Server Functions. Le navigateur n'a pas `node:async_hooks`. Voir risque R2.

### W7. OpenTUI charge une bibliothèque native

`@opentui/core` appelle `libopentui` par `bun:ffi`. Il faut un `opentui.wasm` réduit
et un `FfiBackend` WebAssembly, injecté par alias de build tant qu'OpenTUI n'offre pas
de point d'injection. Ghostty (widget `<Terminal>`) reste hors du cœur : son stub
existe déjà (`embedded-terminal/unavailable.zig`). Voir risque R1.

### W8. Le build n'a pas de sortie navigateur

Trois ajouts, sans toucher aux rôles `server`, `client`, `app` :

- **runtime web** : construit par le framework, **une fois par clé d'ABI et version du
  framework**, pas par application (`target: "browser"`, alias des modules de plateforme,
  `.wasm` à côté). Il
  peut être publié et mis en cache comme un navigateur l'est ;
- **rôle `web-server`** (optionnel) : le graphe Server de l'app, `conditions:
["react-server", "browser"]`, `target: "browser"`, avec les substitutions de W9 ;
- **`.airtty/web/`** : site statique `index.html` + runtime + `app/` (copie de
  `.airtty/app/`) + `server-worker.js` s'il existe. Déployable tel quel (Pages, R2, un
  `iframe` de la landing).

### W9. Le code Server des applications utilise Bun et Node

Un profil Server web, vérifié par le build avec fichier et ligne (comme le top-level
await du bundle d'app) :

| Module                                                    | Dans le navigateur                                                                                                      |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `bun:sqlite`                                              | adaptateur de l'API utilisée (`Database`, `query`, `prepare`, `run`, `transaction`) sur SQLite WASM, persistant en OPFS |
| `Bun.sleep`, `crypto`, `path`, `url`                      | équivalents web                                                                                                         |
| `fs`, `child_process`, `net`, `Bun.spawn`, `Bun.Terminal` | refusés : l'app n'a pas de forme « tout navigateur », seulement « Client web »                                          |

**`server-seed.json`.** Un site statique peut placer ce fichier à côté de
`server-worker.js` (`src/web/server/seed.ts`) : `{ "env": { … }, "files": [ … ] }`. `env`
rejoint `process.env` avant que le code Server de l'app ne le lise ; `files` est un
instantané en lecture seule (`path`, `kind`, `size`, `mtimeMs`, `content` en base64) sur
lequel `node:fs` répond, avec les formes de Node (`Stats`, `Dirent`, erreurs `ENOENT`),
`watch` n'émettant jamais (`node/files.ts`, `tests/web-files.test.ts`). Les écritures
disent `EROFS`, sauf celles, inertes, qu'OpenTUI fait pour ses journaux. Sans ce fichier,
rien ne change.

État des exemples : `notes`, `chat`, `latency` et `forge` peuvent viser les deux formes
(Forge sans l'import d'un dépôt git, `FORGE_GIT_REPO`, ni la touche `e` ; Chat sans clé
avec `CHAT_DEMO=1`) ; `mdreader` et les DevTools aussi, avec une graine (des fichiers
Markdown et `MD_PATH` ; `AIRTTY_DEVTOOLS_LISTEN=none` et `AIRTTY_DEVTOOLS_DEMO=1`) ;
`files` (bibliothèque d'images native, `sharp`) et `agent` (processus) seulement le Client
web ; `mux` et tout `<Terminal>` (PTY) aucune, le runtime web y rend un écran
« indisponible ici ».

## 3. Les deux formes en détail

### Client web → vrai Server

Le Server sert le shell sous un chemin réservé (`GET /_airtty/web/…`, statique, opt-in
par `airtty build --web` et `AIRTTY_WEB_ORIGIN`) : **même origine**, donc ni CORS
ni clé épinglée à gérer ; TLS authentifie le Server comme pour tout site. Le shell lit
`/manifest`, télécharge `/bundle/<sha256>` (immuable, cacheable), refuse une clé d'ABI
autre que la sienne (même message que le terminal) et ouvre l'app.

```text
 Utilisateur        Navigateur (onglet)                    Server (Bun, notes.example.com)
     │                     │                                          │
     │ ouvre https://notes.example.com/_airtty/web                    │
     │────────────────────▶│                                          │
     │                     │ ① GET /_airtty/web/                      │
     │                     │─────────────────────────────────────────▶│ routes /_airtty/web/*
     │                     │◀──────── index.html, runtime.js,         │ (nouvelles, opt-in)
     │                     │          opentui.wasm, xterm.css         │
     │                     │                                          │
     │                     │ ② GET /manifest                          │
     │                     │─────────────────────────────────────────▶│ appRoutes
     │                     │◀──────── manifeste (buildId, clé d'ABI)  │ (existant)
     │                     │                                          │
     │                     │   clé d'ABI comparée : même Server,      │
     │                     │   même build → toujours égale            │
     │                     │                                          │
     │                     │ ③ GET /bundle/<sha256>                   │
     │                     │─────────────────────────────────────────▶│ appRoutes
     │                     │◀──────── bundle d'application            │ (existant)
     │                     │                                          │
     │                     │   bundle évalué, Application créée,      │
     │                     │   xterm.js affiché                       │
     │                     │                                          │
     │ tape, navigue       │ ④ POST (render, Server Function, live)   │
     │────────────────────▶│─────────────────────────────────────────▶│ handler habituel
     │◀──── écran ─────────│◀──────── Flight                          │ (inchangé)
```

Seule l'étape ① est propre au web : le Server fournit le Client, et le navigateur fixe
l'origine. ② et ③ sont les requêtes du Client générique ; ④ est le protocole du Client
terminal. Parce que ② à ④ vont à l'origine de ①, le navigateur les autorise sans CORS,
TLS couvre à la fois le code et le Server, et le bearer reste sous l'origine de l'app.

Un shell hébergé ailleurs (`airtty.dev/open?url=…`) est une seconde étape : CORS
explicite côté Server, signature d'éditeur vérifiée et clé épinglée par origine en
`localStorage`, comme le Client générique.

**Origine déclarée.** Le Server refuse aujourd'hui toute requête portant `Origin`
(`handle`, « Browser origins are unsupported ») : une page quelconque ne doit pas piloter
un Server local. Un navigateur envoie `Origin` à chaque `POST`, même vers son origine. Le
mode web accepte donc **une seule origine, déclarée** par l'opérateur
(`AIRTTY_WEB_ORIGIN=https://notes.example.com`) : `Origin` doit lui être égale, et `Host`
aussi. Comparer `Origin` à `Host` ne suffirait pas : un DNS rebinding donne à une page
hostile un `Host` à son nom. Sans origine déclarée, pas de routes `/_airtty/web` et le
refus actuel reste entier.

Authentification : inchangée. `server/auth.ts` et sa route publique de connexion
fonctionnent comme dans le terminal ; le bearer vit en mémoire (ou `sessionStorage`),
jamais en `localStorage`.

Cycle de vie : un Server web n'est pas géré par un lanceur ; pas de `/lifetime`, pas de
grâce. Fermer l'onglet est une interruption (session gardée), pas un quit.

### Tout dans le navigateur

```text
airtty build --web            → .airtty/web/ (Client web seul, servi par le Server)
airtty build --web-local      → .airtty/web/ : site statique, Server dans un SharedWorker
```

Le Server est un **SharedWorker** (décision 2) : une instance par origine, partagée par
tous les onglets de l'app, comme un vrai Server partagé par ses Clients. Chaque onglet s'y
connecte par un `MessagePort` ; une Server Function d'un onglet invalide aussi les
autres, par le même mécanisme que le live. Le SharedWorker vit tant qu'un onglet vit.
Un navigateur sans SharedWorker (Chrome Android avant mai 2026) retombe sur un Worker
dédié, protégé par un verrou Web Locks : un second onglet affiche « app déjà ouverte
ailleurs » au lieu d'ouvrir une seconde base.

**Conséquence sur SQLite.** L'accès synchrone aux fichiers OPFS
(`FileSystemSyncAccessHandle`) n'existe que dans un Worker dédié, pas dans un
SharedWorker, et l'API de `bun:sqlite` que les apps appellent est synchrone. Le Server
web garde donc la base **en mémoire** (SQLite WASM, synchrone) et la persiste par
instantané (`sqlite3_js_db_export`) dans OPFS de façon asynchrone, écrit **avant la
réponse** de chaque Server Function : une action confirmée est durable, une lecture ne
coûte rien. Au démarrage, le SharedWorker recharge le dernier instantané. Le coût grandit
avec la base : adapté à une démo et à une app locale, pas à une grosse base (au-delà,
une VFS asynchrone demanderait une API `bun:sqlite` asynchrone, donc un autre contrat).

Pour la landing : `website/` embarque `.airtty/web/` de `examples/forge` et
`examples/notes` dans des `iframe` (isolation du CSS et du focus clavier), le runtime
partagé une fois sous `demo/runtime/` (`website/scripts/demo.ts`). La même règle d'origine
vaut : le site statique fournit shell, bundle et `server-worker.js` sous sa propre origine.
OPFS est partagé par toute l'origine : le Server web range ses données sous le nom de l'app.

### Page embarquée

Une page **de la même origine** qui place le runtime dans un `iframe` le pilote ainsi
(`src/web/embed.ts`, vérifié par `bun run test:web:embed`) :

| Sens              | Forme                                                                                                                                   | Pour                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| URL de l'`iframe` | `?columns=140&rows=40`                                                                                                                  | une grille fixe, la police ajustée pour la contenir                                                                       |
| URL de l'`iframe` | `&background=0a0f16&foreground=e6edf3`                                                                                                  | les couleurs par défaut du terminal et de la page                                                                         |
| URL de l'`iframe` | `&restore=off`                                                                                                                          | démarrer sur la première route, sans restaurer ni garder la session (la landing revient à l'écran de sa capture)          |
| runtime → page    | `{ source: "airtty", type: "stage", stage }`, dans l'ordre `runtime`, `bundle`, `server`, `terminal`, `drawn`                           | afficher le démarrage pendant l'attente                                                                                   |
| page → runtime    | `{ source: "airtty", type: "input", data }`                                                                                             | taper dans le terminal comme un clavier                                                                                   |
| runtime → page    | `{ source: "airtty", type: "event", event }` : les événements du transport (`request`, `response`, `end`, `error`) et les invalidations | montrer ce qui traverse le réseau                                                                                         |
| page → runtime    | `{ source: "airtty", type: "network", latencyMs, fault? }`                                                                              | un aller-retour simulé (moitié à l'aller, moitié au retour) et la panne de la prochaine requête (`refuse`, `drop`, `cut`) |

La latence passe par le `fetch` de l'Application : le transport la mesure comme celle d'un
Server lointain, et ses propres pannes (`AIRTTY_FAULT`) s'appliquent. Embarqué, le terminal ne prend pas le focus au démarrage : il ferait défiler la page vers
lui. Une page d'une autre origine n'entend aucune étape (`postMessage` vise l'origine du
runtime) et ce qu'elle envoie est ignoré : elle ne doit pas piloter une application qu'elle
encadre. La landing (`LiveTerminal.astro`) montre la capture de l'écran pendant le
démarrage, la remplace à la même grille, et lit l'écran de l'`iframe` par son DOM pour
dérouler un script (connexion à Forge).

## 4. Rendu et entrée

- `createCliRenderer({ stdin, stdout, useThread: false })` : la sortie ANSI
  (NativeSpanFeed) va à l'émulateur, ses frappes et collages vont à `stdin`, son
  redimensionnement appelle `renderer.resize`. Restent à fournir `process.on`,
  `process.platform/env`, `events`, et des `fs` inertes (logs) : un petit module
  `process` du runtime web.
- Émulateur : **xterm.js** (décision 3), comme `packages/desktop`.
- Plus tard, un renderer qui peint directement le buffer de cellules d'OpenTUI sur un
  canvas supprimerait l'aller-retour ANSI ; ce n'est pas nécessaire pour commencer.
- Clavier : les gestes suivent `AIRTTY_DESKTOP` (Ctrl+C à l'app) ; les raccourcis du
  navigateur (Ctrl+W, Ctrl+T) ne sont pas interceptables et ne doivent pas être promis.

## 5. Plan

| Étape | Contenu                                                          | Vérifié par                                            |
| ----- | ---------------------------------------------------------------- | ------------------------------------------------------ |
| 0     | Spikes R1 et R2, hors de `src/`, dans `probes/web/` — **fait**   | une `<box>` rendue ; un `await` qui garde son contexte |
| 1     | W1 à W5 à comportement constant — **fait**                       | `bun run verify`, parcours PTY                         |
| 2     | Runtime web + Client web servi par le Server — **fait**          | `examples/notes` ouvert dans Chrome, headless          |
| 3     | W6, rôle `web-server`, W9, `airtty build --web-local` — **fait** | `bun run test:web:local` : Notes en site statique      |
| 4     | Landing : `iframe` de notes dans `website/` — **fait**           | capture de la page                                     |
| 5     | Shell hébergé ailleurs (CORS, signature, clé épinglée)           | —                                                      |

Les tests navigateur suivent le modèle des parcours PTY : un script Bun qui pilote
Chrome headless (CDP), tape, et lit l'écran par le buffer de l'émulateur plutôt que par
des captures.

## 6. Risques

**R1 — OpenTUI en WASM : le modèle mémoire.** Upstream n'a ni cible wasm
(`packages/native/build.zig` : Linux, macOS, Windows) ni paquet web, et s'en est éloigné
(Yoga intégré au binaire, roadmap #821). Mesuré sur 0.5.12, sources extraites des
source maps :

- 425 symboles ; ni `cstring`, ni `callback` en argument (5 callbacks passés en `ptr`
  via `createCallback`) ; 167 prennent une vue JS, presque tous le temps de l'appel :
  un marshaller « copie à l'entrée, recopie à la sortie » suffit ;
- **pointeurs retenus** : `textBufferRegisterMemBuffer`/`textBufferAppend`
  (`retainedPtrOrNull`) gardent une adresse de mémoire JS au-delà de l'appel (`<text>`).
  En WASM : copie dans un `malloc` du module, et vérifier que le JS ne modifie pas le
  buffer ensuite ;
- **vues vivantes** : `buffer.ts` garde des vues sur les cellules natives (hit-test des
  liens, `post/`). Des vues sur `memory.buffer` sont vivantes aussi, mais un
  `memory.grow` les détache : les recréer à chaque croissance ;
- **structs** (`zig-structs.ts`) : pointeurs sur 8 octets, faux en wasm32. Adapter le
  layout, ou compiler en wasm64 (memory64) si les navigateurs visés l'ont ;
- **pas de point d'injection** : `platform/ffi` choisit son backend au chargement du
  module, et `zig.ts` résout la bibliothèque par un top-level await. Il faut des alias
  au bundler, puis une contribution upstream (R4) ;
- **compilation** : `wasm32-wasi` pour la libc (libwebp, lcms2, stb, wuffs) ; Yoga
  est compilé avec `-fexceptions -frtti` (libc++ avec exceptions en wasm32 : à
  vérifier) ; `std.Thread` à neutraliser (render thread : `useThread: false`).
  Audio, images, clipboard, VT et tree-sitter sont exclus du cœur minimal : ~1 à 2 Mo
  estimés en ReleaseSmall, contre 5,3 Mo pour la dylib complète.

La sortie est déjà prête : un `stdout` autre que `process.stdout` passe par
NativeSpanFeed, synchrone, vers `stdout.write` avec contre-pression ; `stdin` est un
`Readable` quelconque ; `renderer.resize(w, h)` remplace SIGWINCH.

**Levé** par le spike ([probes/web](../probes/web/README.md)) : un patch de 5 fichiers
natifs (sans effet sur la dylib native, exports identiques), un backend `FfiBackend` WASM
substitué au build, et les deux alias de mémoire native d'OpenTUI (cellules, compteurs de
NativeSpanFeed) servis par des vues vivantes. Une app `@opentui/react` avec `<input>` et
`<scrollbox>` rend le même écran qu'en natif, sous Bun et dans Chrome derrière xterm.js ;
815 Ko brotli au total. Yoga passe en `-fno-exceptions` ; les structs partagées passent
leurs longueurs en `u64`. Une lecture restait en 64 bits : le pointeur des sources de
ligne (`textBufferViewGetLineSources`), dont la moitié haute est en wasm32 la longueur qui
suit ; lu en 32 bits (`opentui/plugin.ts`), la gouttière de `<code>` et `<diff>` retrouve
ses numéros.

**Tree-sitter** (coloration de `<code>`, `<diff>`, `<markdown>`) : le runtime web compile
le Worker d'OpenTUI (`parser.worker.ts`) en script classique, puisqu'OpenTUI le lance par
`new Worker(url)`, et y remplace `DownloadUtils` par des `fetch` (`tree-sitter-downloads.ts`)
: le cache HTTP du navigateur tient lieu de répertoire de données. `tree-sitter/` porte le
Worker, `tree-sitter.wasm` et les parsers par défaut avec leurs requêtes (JavaScript,
TypeScript, Markdown, Zig), chargés seulement quand un écran colore du code.

**R2 — contexte asynchrone sans `AsyncLocalStorage`. Levé** ([probes/web](../probes/web/README.md)).
Chrome 153 n'a pas `AsyncContext`, et Bun ne polyfille pas `node:async_hooks` pour le
navigateur. Le bundle `web-server` reçoit donc son propre `AsyncLocalStorage` (même API)
et une transformation au build (API TypeScript, comme `"use cache"`) : chaque `await x`
devient `__ac.resume(__ac.save(), await x)`, de même pour `yield` des générateurs async et
`for await` ; `then`, `setTimeout`, `setInterval`, `queueMicrotask` sont patchés. Sur 50
requêtes entrelacées (délais, `Promise.all`, micro-tâches, flux live, `run` imbriqués) :
0 désaccord sous Bun et dans un Worker Chrome, comme le vrai `AsyncLocalStorage` ; 750
sans la transformation. Limite : du code non transformé qui reprend seul (un flux natif)
voit le dernier contexte courant ; les stores ne valent que pour le code transformé.

**R3 — poids.** Mesuré au spike : 815 Ko brotli (React, OpenTUI, xterm.js, `.wasm`),
sans TanStack ni le runtime airtty. La démo Notes complète de `website/` (`--web-local`,
Server et SQLite compris) pèse ~1,7 Mo compressé, chargée à la demande.

**R4 — dette de maintenance.** Le backend FFI et le build wasm vivent dans airtty
(décision 4) : ils touchent l'intérieur d'OpenTUI et peuvent casser à chaque version.
Contenu par l'ABI, qui fixe la version exacte d'OpenTUI : une mise à jour est un
changement de clé, vérifié par le test du runtime web.

**R5 — taille de la base du Server web.** L'instantané par action (§ 3) coûte la
taille de la base à chaque Server Function. À mesurer ; au-delà de quelques Mo, il
faudra une persistance incrémentale.

## 7. Décisions

1. **Le Server sert le shell (même origine).** Pas de CORS ; TLS authentifie le Server ;
   le shell correspond toujours à l'ABI du build. Un shell hébergé ailleurs (étape 5)
   reprendra la signature d'éditeur et l'épinglage par origine du Client générique.
2. **SharedWorker dès le départ.** Un seul Server par origine : une base, des
   invalidations qui atteignent tous les onglets. Prix : base en mémoire persistée par
   instantané (§ 3), repli sur Worker dédié et Web Locks sans SharedWorker.
3. **xterm.js.** Mature, déjà dans `packages/desktop`. L'émulateur reste derrière une
   petite interface (écrire, recevoir les touches, taille) : ghostty-web, compatible
   avec son API, reste une option si la fidélité le demande.
4. **Backend FFI WASM dans airtty.** Un plugin de build remplace `platform/ffi` et la
   résolution de la bibliothèque d'OpenTUI ; airtty compile `opentui.wasm` depuis les
   sources de la version fixée par l'ABI. Chaque mise à jour d'OpenTUI change déjà la clé
   d'ABI : c'est là que le backend est revérifié (un test du runtime web par clé). Un point
   d'injection upstream reste souhaitable ; il n'est pas un prérequis.
