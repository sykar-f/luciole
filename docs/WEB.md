# Étude — cible web : le Client (et le Server) dans un navigateur

> **Statut : étude, décisions prises (§ 7).** Rien n'est implémenté. Deux inconnues
> bloquantes (R1, R2) se lèvent par des spikes avant toute modification de `src/`.

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
│  │ ghostty-web │ ◀────── │ runtime web (build du framework, par ABI)  │   │
│  │ ou xterm.js │ ──────▶ │  React, TanStack, keymap, airtty/client    │   │
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

## 2. Obstacles dans `src/` et refactors proposés

Chaque refactor est d'abord fait **à comportement constant** pour le terminal, vérifié par
les tests et parcours PTY existants, avant qu'une ligne web n'existe.

### W1. `run()` mélange l'Application et la plateforme terminal

`client.tsx` importe `connect`, `session`, lit `process.env`, écoute les signaux et
`process.on("message")`, crée le renderer sur le TTY. Le reste (`Application`,
`Shell`, hooks) est neutre.

**Refactor** : `run()` part dans `src/platform/terminal.tsx` (réexporté par
`airtty/client` pour ne rien casser) ; `client.tsx` n'importe plus rien de Node. Le
runtime web a son pendant, `src/platform/web.tsx` :

```ts
runInBrowser({
  element, // où monter l'émulateur
  bundle, // AppBundle déjà vérifié (W3)
  fetch, // réseau ou Worker (W2)
  storage, // SessionStore web (W4)
  host, // HostChannel web
});
```

### W2. `serve()` lie le handler à `Bun.serve`

**Refactor** : extraire `createHandler(config): (req: Request) => Promise<Response>`
(auth, routes, actions, Flight, cache, instrumentation) ; `serve()` devient
`createHandler` + environnement + `Bun.serve` + socket + `managedLifetime`. Le Worker
web appelle `createHandler` et répond aux `postMessage` du Client ; les corps restent des
`ReadableStream` (transférables), donc le live et le streaming Flight passent tels quels.

### W3. `loadAppBundle` lit le disque et évalue par `node:vm`

**Refactor** : séparer la vérification et l'évaluation pures
(`evaluateAppBundle(manifest, code, require)`, hash par une fonction injectée) du
chargement disque. Le web lit par `fetch`, hache par `crypto.subtle`, évalue par
`new Function`. La table `RUNTIME` de l'ABI est la même ; elle vit dans un module partagé
par les deux runtimes.

### W4. Session et hôte supposent le système de fichiers et des binaires

`SessionStore` devient une interface : fichier XDG pour le terminal, `localStorage` (ou
IndexedDB) par origine pour le web. `directChannel` (`child_process`, `pbcopy`,
`open`…) garde son rôle terminal ; `webChannel` répond par `navigator.clipboard`,
`window.open`, `Notification`.

### W5. Flight côté Server passe par `node:stream`

`src/flight/server.ts` convertit un `PassThrough`. Passer à
`react-server-dom-webpack/server.edge` (flux web natifs) partout supprime la conversion,
côté Bun comme côté navigateur.

### W6. Le contexte de requête repose sur `AsyncLocalStorage`

Trois magasins : le contexte de requête (`server.ts` : session, callId, invalidations),
`cacheScope` et `renderTags` (`src/cache/scope.ts`). Ils doivent survivre aux `await`
des Server Functions. Le navigateur n'a pas `node:async_hooks`. Voir risque R2.

### W7. OpenTUI charge une bibliothèque native

`@opentui/core` appelle `libopentui` par `bun:ffi`. Il faut un `libopentui.wasm` réduit
et un `FfiBackend` WebAssembly, injecté par alias de build tant qu'OpenTUI n'offre pas
de point d'injection. Ghostty (widget `<Terminal>`) reste hors du cœur : son stub
existe déjà (`embedded-terminal/unavailable.zig`). Voir risque R1.

### W8. Le build n'a pas de sortie navigateur

Trois ajouts, sans toucher aux rôles `server`, `client`, `app` :

- **runtime web** : construit par le framework, **une fois par clé d'ABI**, pas par
  application (`target: "browser"`, alias des modules de plateforme, `.wasm` à côté). Il
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

État des exemples : `notes`, `chat`, `latency` peuvent viser les deux formes ; `files`,
`mdreader`, `agent` (fs) et `forge` (git, CI) seulement le Client web ; `mux` et tout
`<Terminal>` (PTY) aucune, le runtime web y rend un écran « indisponible ici ».

## 3. Les deux formes en détail

### Client web → vrai Server

Le Server sert le shell sous un chemin réservé (`GET /_airtty/web/…`, statique, opt-in
par `serve --web` ou `airtty.web` dans `package.json`) : **même origine**, donc ni CORS
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
     │                     │          libopentui.wasm, xterm.js       │
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

Authentification : inchangée. `server/auth.ts` et sa route publique de connexion
fonctionnent comme dans le terminal ; le bearer vit en mémoire (ou `sessionStorage`),
jamais en `localStorage`.

Cycle de vie : un Server web n'est pas géré par un lanceur ; pas de `/lifetime`, pas de
grâce. Fermer l'onglet est une interruption (session gardée), pas un quit.

### Tout dans le navigateur

```text
airtty build --web            → .airtty/web/ (Client web seul, Server à indiquer)
airtty build --web=local      → .airtty/web/ avec server-worker.js (tout navigateur)
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

Pour la landing : `website/` embarque `.airtty/web/` de `examples/notes` dans un
`iframe` (isolation du CSS et du focus clavier). La même règle d'origine vaut : le site
statique fournit shell, bundle et `server-worker.js` sous sa propre origine. OPFS est
partagé par toute l'origine : le Server web range ses données sous le nom de l'app.

## 4. Rendu et entrée

- `createCliRenderer({ stdin, stdout, useThread: false })` : la sortie ANSI
  (NativeSpanFeed) va à l'émulateur, ses frappes et collages vont à `stdin`, son
  redimensionnement appelle `renderer.resize`. Restent à fournir `process.on`,
  `process.platform/env`, `events`, et des `fs` inertes (logs) : un petit module
  `process` du runtime web.
- Émulateur : **ghostty-web** si son API compatible xterm.js tient ses promesses (même VT
  que le cœur d'OpenTUI), sinon **xterm.js** (déjà utilisé par `packages/desktop`).
- Plus tard, un renderer qui peint directement le buffer de cellules d'OpenTUI sur un
  canvas supprimerait l'aller-retour ANSI ; ce n'est pas nécessaire pour commencer.
- Clavier : les gestes suivent `AIRTTY_DESKTOP` (Ctrl+C à l'app) ; les raccourcis du
  navigateur (Ctrl+W, Ctrl+T) ne sont pas interceptables et ne doivent pas être promis.

## 5. Plan

| Étape | Contenu                                                       | Vérifié par                                            |
| ----- | ------------------------------------------------------------- | ------------------------------------------------------ |
| 0     | Spikes R1 et R2, hors de `src/`, dans `probes/web/`           | une `<box>` rendue ; un `await` qui garde son contexte |
| 1     | W1 à W5 à comportement constant                               | `bun run verify`, parcours PTY                         |
| 2     | Runtime web + Client web servi par le Server (`/_airtty/web`) | `examples/notes` ouvert dans Chrome, headless          |
| 3     | W6, rôle `web-server`, W9, `airtty build --web=local`         | notes, chat, latency tout navigateur                   |
| 4     | Landing : `iframe` de notes dans `website/`                   | capture de la page                                     |
| 5     | Shell hébergé ailleurs (CORS, signature, clé épinglée)        | —                                                      |

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

Spike : `libopentui` réduit en `wasm32-wasi` (renderer, buffer, texte, édition, Yoga,
uucode), backend par alias qui marshalle et copie les buffers retenus, un
`<box><text>` rendu avec `useThread: false` et un `stdout` custom, sous Bun puis dans
Chrome. Il tranche en un essai Yoga, les pointeurs retenus et les structs.

**R2 — contexte asynchrone sans `AsyncLocalStorage`.** Le proposal TC39
`AsyncContext` n'est pas acquis dans tous les navigateurs. Pistes, dans l'ordre :
`AsyncContext` natif là où il existe ; un polyfill qui réécrit les `await` au build
(plugin `onLoad` sur le seul bundle `web-server`) ; en dernier recours, sérialiser les
requêtes du Worker hors flux live, acceptable pour un Server à un seul utilisateur mais
pas pour un rendu qui attend une action.

**R3 — poids.** React, TanStack, OpenTUI JS et le `.wasm` : à mesurer au spike ;
chargé une fois par version d'ABI et mis en cache immuable.

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
   résolution de la bibliothèque d'OpenTUI ; airtty compile `libopentui.wasm` depuis les
   sources de la version fixée par l'ABI. Chaque mise à jour d'OpenTUI change déjà la clé
   d'ABI : c'est là que le backend est revérifié (un test du runtime web par clé). Un point
   d'injection upstream reste souhaitable ; il n'est pas un prérequis.
