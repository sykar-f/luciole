# DevTools

L'équivalent de Chrome DevTools et React DevTools pour une application airtty : un
waterfall des requêtes Client **et** Server avec le cache qui a répondu, l'arbre des
composants Client et Server avec la raison de chaque rendu, les logs des deux processus,
l'état du routeur, les touches reçues et les conditions réseau en direct.

## Démarrer

Deux panneaux de terminal :

```sh
# panneau 1 : les DevTools
bun packages/airtty/src/cli.ts devtools            # airtty devtools, une fois le package installé

# panneau 2 : l'application inspectée
eval "$(bun packages/airtty/src/cli.ts devtools --env)"
bun run dev                        # ou n'importe quel `airtty dev --app …`
```

`--env` imprime les deux variables à exporter :

| Variable          | Rôle                                                                                                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AIRTTY_DEVTOOLS` | Adresse des DevTools : `1` (socket Unix par défaut, par utilisateur), un chemin (`/…` ou `unix:/…`) ou `ws://hôte:port`. Lue par le Client (`run()`) et le Server (`serve()`).     |
| `BUN_OPTIONS`     | `--preload=<airtty>/src/devtools/hook.ts` : le hook de fibers, requis par le seul panneau Components. Sans lui, tout le reste fonctionne et le panneau explique comment l'activer. |

`airtty devtools` écoute sur `--listen`, à défaut sur `AIRTTY_DEVTOOLS` du shell, à défaut
sur le socket par défaut. `--demo` rejoue une session simulée (voir « Contrat avec
feat/use-cache »), `--replay fichier.json` rouvre un enregistrement.

**Coût nul sans la variable.** Le Server rend l'`instrument` configuré tel quel (aucune
réponse n'est enveloppée) ; le Client n'exécute pas l'import dynamique de l'agent. Sous
`NODE_ENV=production` (`airtty start`), la variable est ignorée avec un avertissement.

## Architecture

```text
application inspectée                                   DevTools (une app airtty)
┌─────────────────────────┐                           ┌───────────────────────────────┐
│ Client  client-agent.ts │── socket, NDJSON ────────▶│ Server  server/store.ts       │
│   onEvent, routeur,     │◀─ commandes ──────────────│   bus + journal d'événements  │
│   console, fibers       │                           │            │ subscribe()      │
│ Server  server-agent.ts │── socket, NDJSON ────────▶│            ▼ (live, Flight)   │
│   ServerEvent, console  │                           │ Client  panneaux OpenTUI      │
└─────────────────────────┘                           └───────────────────────────────┘
```

Les DevTools **sont une application airtty** (`src/devtools/airtty-devtools/`), ce qui
fait tourner le framework sur lui-même : leur Server tient le bus et le journal, leur
Client lit ce journal par une Server Function live (`subscribe`, générateur asynchrone),
chaque panneau est une route ; celles qui pilotent l'application (Components, Router,
Cache, Conditions) reçoivent de leur page Server la Server Function `command`, le filtre
de la console voyage en search param (`/console?callId=…`).
`airtty devtools` (`src/commands/devtools.ts`) construit cette application et lance ses
deux processus en retirant `AIRTTY_DEVTOOLS` et le preload de leur environnement : les
DevTools ne s'inspectent jamais elles-mêmes.

Les DevTools écoutent, les processus inspectés se connectent. Chacun envoie d'abord un
`hello` (protocole, rôle, pid, application, répertoire ; le Server y ajoute son build et
les sources des Server Components, le Client la présence du preload), puis ses messages.
Tant qu'aucune DevTools n'écoute, un processus garde ses 2 000 derniers messages et
réessaie chaque seconde ; ses sockets sont `unref` (ils ne retiennent jamais un processus) et un
lecteur qui ne lit plus ne peut pas lui faire dépasser 8 Mio en attente (les messages en
trop sont comptés et signalés, `airtty:dropped`).

**Sécurité.** Le socket par défaut est dans `$XDG_RUNTIME_DIR` (ou le `tmpdir()` privé de
macOS), nommé par uid, en `0600`. Un socket laissé par des DevTools mortes est réutilisé,
jamais celui de DevTools vivantes. En `ws://`, le listener refuse toute requête portant un
en-tête `Origin` (une page web ne peut pas piloter l'application) ; il écoute sur l'hôte
donné, à garder local. Les commandes possibles restent de développement : invalider,
rafraîchir, conditions réseau, flash, et purger un tag du cache Server (la seule qui
modifie l'état du Server).

## Protocole

L'enveloppe est celle de TanStack DevTools (`@tanstack/devtools-event-client`) :

```ts
type Message = { type: `${pluginId}:${suffix}`; pluginId: string; payload: unknown };
```

| Plugin              | Suffixes                                                                                                                      | Émis par         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `airtty`            | `hello`, `dropped`                                                                                                            | chaque processus |
| `airtty-client`     | un par `ApplicationEvent.type` : `request`, `response`, `chunk`, `end`, `error`, `navigation`, `invalidate`, `loader`         | Client           |
| `airtty-server`     | un par `ServerEvent.type`, et `cache`                                                                                         | Server           |
| `airtty-console`    | `entry` (`level`, `text`, `stack`, `callId` côté Server)                                                                      | les deux         |
| `airtty-components` | `commit` (arbre aplati, rendus), `unavailable`                                                                                | Client           |
| `airtty-router`     | `state` (matches, matches en cache, location)                                                                                 | Client           |
| `airtty-input`      | `key`                                                                                                                         | Client           |
| `airtty-devtools`   | commandes : `invalidate`, `refresh`, `network`, `highlight`, `select`, `snapshot` (au Client), `cache-invalidate` (au Server) | DevTools         |

Les payloads sont validés par Zod à l'arrivée (`src/devtools/schema.ts`), en objets
« loose » : un champ ajouté par une version plus récente du framework atteint la vue
détaillée au lieu d'être supprimé ; un message invalide est compté (« rejected »). Le
transport (`src/devtools/wire.ts`) est du JSON délimité par lignes sur socket Unix, ou un
message par trame WebSocket.

**Compatibilité TanStack** : la sonde [probes/devtools-tanstack](../probes/devtools-tanstack/README.md)
fait passer une session complète par leur vrai `ServerEventBus` jusqu'à un shell simulé,
dans les deux sens. Un front web réutilisant leur shell est réaliste, par un pont dans le
processus qui tient le bus ; notre conception n'en dépend pas.

## Panneaux

Touches communes : `1`–`7` ou `Tab` changent de panneau, `j`/`k`/flèches sélectionnent,
`G` suit le plus récent dans les listes live (Network, Console) et revient en tête
ailleurs, `p` met en pause (les événements sont gardés et appliqués à la reprise), `C`
vide, `E` exporte.

### 1 Network

Une ligne par requête, Client et Server joints par `callId`, reliée au loader de page
qui l'a demandée (même route, même cause) :

```text
  name                       cause cache time   ░ queued ▒ waiting █ server ━ stream ╋ chunk ◆ cache
  ✓ ▣ /notes/1                 nav   hit   28ms           ░▒██▒━╋━╋
 ↳✓ ƒ getComments              act         31ms                     ▒███▒━╋
  ◆ ▣ /                        nav   mem   0ms                             ◆
 ⟳✓ ▣ /notes/1                 inv   stale 31ms                                 ░▒██▒━╋━━╋
```

- **Phases** : attente (du début du loader à l'envoi, latence ajoutée comprise), attente
  de la réponse, travail du Server (de son `request` à ses en-têtes), flux jusqu'à la fin
  du corps avec un repère par chunk. Une ligne encore ouverte (flux live) s'étend jusqu'à
  maintenant. Le détail redessine la requête sélectionnée à sa propre échelle.
- **Cause** : celle du Client (`nav`, `pre`, `ref`, `inv`, `act`, `live`).
- **Cache** : `mem` servi par le cache du routeur Client, sans requête (le « (memory
  cache) » de Chrome) ; `hit`, `miss`, `stale`, `part` selon les événements `cache` du
  Server pour ce `callId`.
- **`↳` waterfall séquentiel** : la requête est partie moins de 25 ms après la réponse
  d'une autre (elle l'attendait probablement). Ne comptent ni un préchargement, ni un flux
  live, ni un redémarrage après annulation, ni le rendu que l'invalidation d'une action a
  demandé (son lien est la cause).
- **`⟳` double invalidation** : une même cause a rendu deux fois la même page. La cause
  d'une invalidation est l'action dont la réponse est arrivée dans les 250 ms qui
  précèdent (sinon elle-même) : l'`invalidate()` du Server et celui du composant après la
  même action sont une seule cause, et leurs deux rendus sont signalés.

`f` filtre (tout, signalés, rendus, actions, cache), `z` zoome sur les dernières 60 s,
10 s, 2 s, `o` ouvre la console filtrée sur la requête.

### 2 Components

L'arbre des composants Client et, au-dessus des éléments qu'ils ont produits, les
**Server Components** que Flight décrit en développement (`_debugInfo`, marqués `◇`).
Pour chaque composant : nombre de rendus, raison du dernier (`mount`, `props: a, b`,
`state`, `context`, `parent`), props, hooks nommés, position à l'écran, et l'emplacement
dans les sources (« Nom · fichier:ligne », `o` l'ouvre dans `$VISUAL`/`$EDITOR`).

- **Rendu inutile** (`⚠`) : rendu avec des props, un état et un contexte égaux (au sens de
  `memo()`), seulement parce que son parent a rendu. `u` n'affiche que ceux-là.
- **Flash animé** : les lignes des composants qui viennent de rendre s'allument puis
  s'éteignent ; `h` les fait aussi clignoter **dans le terminal de l'application**, en
  contour coloré (vert : une fois ; jaune, orange : souvent ; rouge : inutile), dessiné par
  une passe de post-traitement OpenTUI à partir des renderables (x, y, largeur, hauteur) :
  la mise en page de l'application ne bouge jamais. Le composant sélectionné est entouré
  en bleu dans l'application.
- La plomberie (bordure d'erreur d'OpenTUI, providers du Shell, matches et outlets de
  TanStack Router, `Suspense` du routeur) est masquée ; `a` l'affiche.

Noms, emplacements et hooks viennent du build (section suivante). Un éditeur de terminal
prend le panneau des DevTools le temps de l'édition ; un éditeur graphique (`code`,
`cursor`, `zed`…) est seulement lancé à la bonne ligne.

## Noms, sources et source maps

**Source maps.** `airtty build` (donc `airtty dev`) écrit `index.js.map` à côté de chaque
bundle, Client et Server, lié par `//# sourceMappingURL` (`sourcemap: "linked"`). Lié plutôt
qu'externe : Bun applique alors la map aux stack traces à l'exécution (en développement
comme en production) et un débogueur la trouve ; une map externe ne serait lue par rien.
Pas en ligne : elle doublerait le bundle, que `--compile` embarque. Pour que la map pointe
sur les lignes d'origine, le build laisse Bun retirer le TypeScript des fichiers `.ts/.tsx`
(Bun ne compose pas une map fournie par un plugin) ; le `@jsxImportSource` de chaque rôle
passe en pragma sur la première ligne, et le runtime JSX reste celui de production. Les
DevTools en profitent sans lire la map elles-mêmes : la pile d'une erreur loguée (panneau
Console) est déjà en fichiers et lignes d'origine. Limite : un Client compilé
(`--compile`) est reconstruit depuis `index.js` sans sa map ; ses piles restent en
coordonnées du bundle. La map du Client contient les sources du graphe Client, déjà
livrées lisibles (le bundle n'est pas minifié) ; celle du Server reste sur le Server.

**Noms des composants.** Le bundler renomme les identifiants en collision (chaque `Page`
devient `Page2`, `Page3`…). La transformation de chaque module (`src/build-names.ts`,
appelée depuis celle de `build.ts`) ajoute en fin de module un `displayName` d'origine et
un `__airtty = { source, hooks }` à chaque composant (fonction, classe, `memo`/`forwardRef`
nommés) et hook custom de premier niveau, des sources de l'application et du framework,
pas des paquets. L'export par défaut d'un fichier de route prend le nom de sa route quand le
sien est absent ou générique (`Page`, `Layout`…) : `app/notes/[id]/page.tsx` →
`NotesIdPage`, `app/layout.tsx` → `RootLayout`, `app/page.tsx` → `HomePage` ; un export par
défaut anonyme ailleurs prend celui de son fichier (`note-list.tsx` → `NoteList`). Aucune
ligne ne bouge. Les Server Components en profitent aussi : Flight transmet ce `displayName`
dans `_debugInfo`, et l'agent Server envoie dans son `hello` les emplacements par nom
(Flight ne transmet pas le fichier).

**Noms des hooks.** Par annotation au build plutôt qu'à la manière de React DevTools
(rendre à nouveau le composant sous un dispatcher enregistreur, passer la pile de chaque
hook par les source maps, relire le fichier à cette ligne) : une passe sur l'AST par module
au build, rien à l'exécution, aucun code applicatif relancé, pas de bibliothèque de source
maps. Chaque composant et hook custom garde la liste de ses appels de hooks, dans l'ordre
d'évaluation, avec la variable qu'ils alimentent (`const [draft, setDraft] = useState()` →
`draft`, `const { a, b } = useX()` → `a, b`). Les DevTools déroulent cette liste contre les
nœuds de la fibre : un hook de React compte pour un nombre de nœuds fixe (table
`PRIMITIVE_NODES`, vérifiée par un test pour le reconciler épinglé), un hook custom annoté
se déroule à son tour (`local › open`). Limite : un hook d'un paquet (TanStack, OpenTUI)
n'est pas annoté, son nombre de nœuds est inconnu ; les nœuds avant le premier et après le
dernier restent nommés exactement, ceux d'un unique hook de paquet entre les deux portent
son nom (`usePackage › state`), le reste est numéroté (`state #4`). Un compte qui ne tombe
pas juste ne nomme rien plutôt que de nommer faux.

### 3 Console

Les `console.*` du Client (le TUI possède stdout : c'est le seul endroit où les lire) et
du Server, ceux du Server avec le `callId` de la requête sous laquelle ils ont été écrits
(`getCallId()`, contexte asynchrone du rendu ou de l'action). Filtres : niveau (`l`),
processus (`s`), texte (`/`), requête (depuis Network).

`replayConsoleLogs` de Flight : en développement, le Server Flight ajoute au flux les logs
écrits pendant un rendu, que le Client peut rejouer dans sa propre console avec un badge
« Server ». `src/flight/client.ts` le laisse désactivé et c'est voulu : rejoués, ces logs
passeraient par la console que le TUI capture déjà, et doubleraient ceux que l'agent
Server envoie directement, avec leur `callId` en plus. Le flux de développement les
transporte quand même ; les en retirer est une option du Server Flight à étudier si leur
poids compte.

### 4 Router

Inspiré du panneau `@tanstack/react-router-devtools` : location et location résolue,
matches rendus et matches gardés en cache par le routeur (`router._cache`, interne), avec
statut (`*` : invalide), chargement en cours (`↻`), âge (`updatedAt`), `loaderData`
résumé (l'élément racine de l'arbre Flight), params et search. `i` invalide le match
sélectionné dans l'application, `I` tout, `r` rafraîchit.

### 5 Cache

Le cache Server tel que ses événements le décrivent : entrées, fonction, tags, âge depuis
l'écriture, succès/échecs/périmés, invalidations par tag, requêtes qui l'ont lu.

`t` choisit un tag de l'entrée sélectionnée, `x` l'invalide : la commande
`airtty-devtools:cache-invalidate` fait appeler `invalidate({ tag })` par l'agent Server
(la fonction lui est passée par `createHandler()`, pour ne pas importer `server.ts` dans un
cycle). Hors de toute requête, cela **purge le cache Server seulement** : aucun Client
n'est prévenu, chacun verra des données fraîches à son prochain rendu, ce que le panneau
rappelle. Le Server émet alors un événement `cache` `invalidate` par tag (`key` et
`callId` vides), qui marque invalides les entrées portant ce tag ; une erreur arrive dans
la Console.

### 6 Input

Les touches reçues par l'application, avec leurs modificateurs et leur séquence.

### 7 Conditions

Les conditions réseau du Client, **en direct** : latence ajoutée, gigue, délai par chunk,
probabilités de refus/perte/coupure, et des préréglages (`n` aucune, `m` mobile, `s` flux
lent, `f` instable). Les variables `AIRTTY_JITTER_MS`, `AIRTTY_CHUNK_DELAY_MS`,
`AIRTTY_FAULT` ne les fixent qu'au démarrage. La gigue, le délai par chunk et les fautes
modifient en place les `NetworkConditions` que le transport HTTP relit à chaque requête ;
la latence (`AIRTTY_LATENCY_MS` étant figée à la création du transport) est ajoutée avant
l'envoi par le `wrapTransport` de l'agent, et apparaît donc comme attente du loader.

### Enregistrer, rejouer

`E` écrit, dans le répertoire où tournent les DevTools, `airtty-devtools-<date>.json` (le
journal brut, que `--replay` rouvre tel quel) et `.har` (HAR 1.2, lisible par les outils
de Chrome ; ce que HTTP ne sait pas dire, Server, chunks, cause, cache, signalements,
voyage dans des champs `_airtty`).

## Contrat avec feat/use-cache

feat/use-cache est fusionné ; `src/devtools/fixtures.ts` simule toujours ses événements
pour `--demo` et les tests :

- **Server** : `ServerInstrument.onEvent` reçoit `ServerEvent | CacheEvent`, avec
  `CacheEvent = { type: "cache", op: "hit" | "miss" | "stale" | "write" | "invalidate", key, fn, tags, callId, ms, at }`.
  `createHandler()` passe l'instrument combiné (DevTools + configuré) au runtime du cache :
  l'agent envoie chaque événement aux DevTools (`airtty-server:cache`) puis à
  l'`instrument` configuré, qui reçoit exactement ce qu'il recevrait sans les DevTools.
- **Client** : chaque `loader` porte `source` (`network` ou `router-cache`) ; un
  `router-cache`, sans requête, a sa propre ligne, un `network` se relie à sa requête.
  L'agent ne **synthétise** ces lignes (`synthetic: true`) que pour un Client plus ancien
  dont les loaders ne portent pas `source` : la synthèse s'arrête au premier loader qui
  en porte un.

## React DevTools

React DevTools reste utilisable pour l'inspection générique, à côté de nos DevTools :

```sh
npx react-devtools                 # panneau 3 : l'interface standalone (port 8097)
DEV=true bun run dev               # OpenTUI charge react-devtools-core et s'y connecte
```

`react-devtools-core` est déjà installé (dépendance optionnelle d'OpenTUI). Avec
`DEV=true`, OpenTUI importe `react-devtools-core`, appelle `initialize()` puis
`connectToDevTools()`, et son reconciler appelle `injectIntoDevTools()`.

**Pas de conflit.** Notre hook de fibers **chaîne** `__REACT_DEVTOOLS_GLOBAL_HOOK__`, sur le
modèle de react-scan et bippy : avec `DEV=true`, le preload laisse d'abord
`react-devtools-core` installer le vrai hook (l'`initialize()` suivant d'OpenTUI le
trouve et le garde), puis enveloppe son `onCommitFiberRoot`. Sans `DEV`, il installe un
hook minimal. Les deux outils reçoivent chaque commit ; `tests/devtools-fibers.test.ts`
vérifie les deux cas, et que React DevTools garde son renderer.

**Pourquoi un preload.** `@opentui/react` appelle `injectIntoDevTools()` une seule fois, à
son import. Le bundle Client l'importe comme module externe, évalué avant tout code du
bundle : un hook installé depuis le Client arriverait trop tard. Seul un preload Bun
(`BUN_OPTIONS=--preload=…`) passe avant. `BUN_OPTIONS` est hérité par le superviseur,
le Server et le Client d'`airtty dev` ; le hook ne fait rien là où React ne s'enregistre
pas. Un chemin contenant des espaces n'y est pas pris en charge.

**bippy ou implémentation maison.** Maison. La valeur de bippy tient ici dans
l'installation chaînée du hook (quelques lignes, reprises de son modèle) et dans des
utilitaires DOM sans usage dans un terminal. Ce dont le panneau a besoin, raisons de
rendu, valeurs des hooks, `_debugInfo` de Flight, rectangles OpenTUI, filtrage de la
plomberie TanStack, reste à écrire de toute façon, et bippy serait une dépendance de plus
dans chaque bundle Client pour des internes de React qu'il faut suivre nous-mêmes
(react-reconciler 0.33 épinglé, voir [ROUTER.md](ROUTER.md)). `src/devtools/fibers.ts`
lit chaque champ interne défensivement et ignore une forme inconnue.

## Fichiers

| Fichier                                           | Rôle                                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/devtools/protocol.ts`, `schema.ts`           | Enveloppe, plugins, adresses ; validation Zod des événements et commandes.                   |
| `src/devtools/wire.ts`                            | Socket Unix / WebSocket, backlog, reconnexion, listener.                                     |
| `src/devtools/server-agent.ts`                    | `devtoolsInstrument()`, appelé par `createHandler()` : ServerEvent, cache, console.          |
| `src/devtools/client-agent.ts`                    | `startClientAgent()`, appelé par `run()` : événements, routeur, console, touches, commandes. |
| `src/devtools/annotate.ts`                        | Runtime des annotations de noms ajoutées par le build ; sources des Server Components.       |
| `src/devtools/preview.ts`                         | Texte court et borné d'une valeur : arguments de console, props, état de hook.               |
| `src/devtools/hook.ts`, `fibers.ts`, `overlay.ts` | Hook préchargé et chaîné, suivi des rendus, flash dans le terminal.                          |
| `src/devtools/model/`                             | Modèles purs : réseau (waterfalls, doubles invalidations), session, HAR.                     |
| `src/devtools/fixtures.ts`                        | Session simulée, dont le contrat feat/use-cache.                                             |
| `src/devtools/airtty-devtools/`                   | L'application DevTools.                                                                      |
| `src/commands/devtools.ts`                        | `airtty devtools`.                                                                           |

Tests : `tests/devtools-*.test.ts(x)` ; bout en bout dans deux PTY, DevTools contre Notes
sous `airtty dev` : `bun run test:pty:devtools`.

## Reste à faire

- Invalider aussi les Clients depuis le panneau Cache (une commande qui ferait suivre
  l'`invalidate()` Server d'une invalidation des routes Client concernées).
- Keymap : les couches de raccourcis actives de l'application (l'instance du keymap vit
  dans le `Shell`, non exposée) ; seul le journal des touches existe.
- Nommer l'intérieur des hooks de paquets (source maps + AST à la React DevTools, sur
  demande pour le composant sélectionné).
- Plusieurs Clients connectés : les commandes vont à tous, les panneaux mélangent leurs
  arbres et routeurs (dernier état reçu).
- Front web sur le shell TanStack (voir la sonde).
