# Sondes de la cible web

Les spikes de l'étape 0 de [docs/WEB.md](../../docs/WEB.md) : lever R1 (OpenTUI en
WASM) et R2 (contexte asynchrone sans `AsyncLocalStorage`) avant de toucher `src/`.

## `opentui-wasm/` : OpenTUI sur `opentui.wasm` (R1)

```sh
# Zig 0.16.0 exactement (celui qu'OpenTUI 0.5.12 exige)
OPENTUI_SRC=/tmp/opentui ZIG=zig bun probes/web/opentui-wasm/build-wasm.ts
OPENTUI_SRC=/tmp/opentui OPENTUI_WASM_PATH=/tmp/opentui/packages/native/lib/wasm32-wasi/opentui.wasm \
  bun probes/web/opentui-wasm/check-box.ts
```

`build-wasm.ts` clone OpenTUI v0.5.12, applique `opentui-v0.5.12.patch` et compile
`libopentui` en `wasm32-wasi`. `check-box.ts` bundle un probe contre les sources de
`@opentui/core` (`build.ts`, `plugin.ts`), le lance sur un PTY et lit l'écran avec
l'émulateur des parcours PTY : une boîte arrondie titrée et son texte.

### Résultat

**Levé.** `createCliRenderer`, Yoga, `BoxRenderable` et
`TextRenderable` tournent sur le module WASM, sans thread, vers un `stdout` quelconque par
NativeSpanFeed. Écran vérifié par un émulateur ; deux builds depuis un clone neuf
donnent un module identique à l'octet.

| Mesure                   | Valeur                                                    |
| ------------------------ | --------------------------------------------------------- |
| `opentui.wasm` (strippé) | 2,4 Mo ; 452 Ko gzip ; 357 Ko brotli (images comprises)   |
| Exports                  | 639 fonctions ; audio et clipboard exclus (61)            |
| Imports                  | WASI de base (horloges, aléa, fd 1/2), table de fonctions |

### Le patch natif (`opentui-v0.5.12.patch`)

Tout reste identique en natif : la dylib macOS construite avec le patch exporte
exactement les symboles de celle publiée sur npm.

| Changement                                                            | Pourquoi                                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Cible wasm : exécutable reactor, `rdynamic`, table importée           | une bibliothèque WASM sans `main` ; table extensible pour les callbacks JS      |
| Yoga en `-fno-exceptions` sous wasm                                   | pas de runtime d'exceptions C++ en wasm32 ; Yoga le prévoit (`AssertFatal.cpp`) |
| Pas de miniaudio sous wasm ; exports audio/clipboard natifs seulement | threads et périphériques inexistants ; côté JS, « indisponible »                |
| Render thread absent en single-threaded                               | `std.Thread.spawn` ne compile pas en wasm32                                     |
| `StyledChunk` et `ExternalCapabilities` : longueurs en `u64`          | le JS les lit en `u64` ; `usize` ne fait que 4 octets en wasm32                 |
| `wasm-host.zig` : `opentuiWasmAlloc`/`Free`                           | la mémoire où copier les buffers JS avant un appel                              |

### Le côté JS (`plugin.ts`, `src/ffi-wasm.ts`)

Le paquet npm d'OpenTUI est pré-bundlé : le runtime web bundle `@opentui/core` depuis ses
sources, et le plugin y substitue, en vérifiant que chaque source attendue est là :

- `platform/ffi` → `ffi-wasm.ts`, un `FfiBackend` WASM (même API) ; le backend de
  bun-ffi-structs → le même module, pointeurs sur 4 octets ;
- `#opentui/runtime-assets` → le module déjà instancié ; tree-sitter indisponible ;
- `retainedPtrOrNull` → `retainPtr` : une copie qui vit autant que la vue JS ;
- `buffer.ts` et `NativeSpanFeed.ts` : les deux endroits qui exigent un alias de la
  mémoire native (cellules, compteurs de références) reçoivent des vues vivantes sur la
  mémoire du module, refaites après `memory.grow` ; les données d'un span sont copiées au
  drain.

### Interactif : `check-form.ts`

`src/form.tsx` : `@opentui/react`, un `<input>` saisi au clavier (accents, CJK en double
largeur), un `<scrollbox>` des notes soumises, Échap pour quitter, le clavier lu sur le
`stdin` du PTY. `NATIVE=1` lance la même source sur l'OpenTUI natif publié : **l'écran
final est identique à l'octet** entre natif et WASM.

### Dans Chrome : `check-browser.ts`

Le même composant (`src/form-app.tsx`) dans une page : OpenTUI écrit ses frames dans
xterm.js, xterm.js rend les touches comme `stdin` du renderer. `../cdp.ts` pilote un Chrome
headless par le protocole DevTools, sans dépendance : il tape, lit le buffer de xterm.js
et capture `.airtty/browser/screen.png`. Premier frame en ~260 ms en local ; même écran
final qu'en natif.

Ce qu'une page n'a pas et que le bundle navigateur fournit (`src/browser-node/`) :
`process`, `global`, `Buffer` ; `fs` inerte ou refusé, `url`, `os`, `console` ;
`module`, `worker_threads`, `child_process`, `tty` chargeables mais refusés à l'usage.
`events`, `stream`, `buffer`, `path`, `util` restent les polyfills de Bun.

| Charge utile (minifiée)            | Brotli     |
| ---------------------------------- | ---------- |
| JS : React, OpenTUI, xterm.js, app | 457 Ko     |
| `opentui.wasm`                     | 357 Ko     |
| **Total**                          | **815 Ko** |

### Reste à mesurer

- le coût des copies à chaque appel sur un écran réel (Notes) ;
- ce que retirer images et tree-sitter du module gagne en poids.

## `async-context/` : `AsyncLocalStorage` sans le moteur (R2)

```sh
bun probes/web/async-context/check.ts
```

Le Server garde trois contextes à travers les `await` (requête, `cacheScope`,
`renderTags`). Chrome 153 n'a pas `AsyncContext` ; Bun remplace `node:async_hooks` par un
module vide en cible navigateur.

- `src/async-context.ts` : `AsyncLocalStorage` (`run`, `getStore`, `exit`, `enterWith`,
  `bind`, `snapshot`) sur des frames chaînés, chaque storage gardant ses valeurs dans une
  `WeakMap` ; `install()` patche `then`, `setTimeout`, `setInterval`, `queueMicrotask`.
- `src/transform.ts` (API TypeScript 6, comme `src/cache/transform.ts`) :
  `await x` → `__ac.resume(__ac.save(), await x)`, idem pour `yield` dans un générateur
  async, et `for await` restaure son frame à chaque tour et à la sortie.
- `plugin.ts` : `node:async_hooks` → le runtime, et la transformation sur chaque module.

| Variante (50 requêtes entrelacées)       | Désaccords |
| ---------------------------------------- | ---------- |
| `AsyncLocalStorage` de Bun (référence)   | 0          |
| runtime de la sonde, sans transformation | 750        |
| runtime + transformation, sous Bun       | 0          |
| runtime + transformation, Worker Chrome  | 0          |

Limite : du code non transformé qui reprend seul (un flux natif qui tire) voit le dernier
frame courant. Les stores valent pour le code que le build a transformé : tout le bundle
`web-server`, dépendances comprises.
