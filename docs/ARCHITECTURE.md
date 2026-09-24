# Structure et distribution

Le dépôt contient **un framework** et **une application exemple**.
L’application est une codebase unique ; son build produit deux programmes.

## Le framework que nous développons

| Fichier              | Responsabilité                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/cli.ts`         | Arguments et registre des sous-commandes (`src/commands/index.ts`), une par module : init, dev, build, runtime, start, connect. |
| `src/commands/`      | Création du starter, dev (supervision des processus, erreurs de rebuild), build, start/connect, runtime.                        |
| `src/build.ts`       | Lecture de l’AST, graphes Client/Server, validation des frontières, références Flight, routes, manifests et bundles.            |
| `src/route-graph.ts` | Compilation pure de `app/` en route graph : layouts, pages, groupes, params, catch-all, loading/error/not-found.                |
| `src/server.ts`      | HTTP, contexte de session, registre des pages, Server Functions, `notFound()`, `invalidate()`, réponses live.                   |
| `src/route-tree.tsx` | Fabriques de routes de `app/routeTree.gen.ts` : layouts, pages, loaders Flight, écrans error/not-found, Échap.                  |
| `src/transport.ts`   | Interface `Transport` et adapter HTTP/Flight : build ID, bearer, timeout, `outcome`, événements, réseau simulé.                 |
| `src/client.tsx`     | Runtime terminal : TanStack Router, keymap, loaders Flight, actions, invalidation, live, observabilité, hooks.                  |
| `src/restore.ts`     | Session façon navigateur : historique et texte des champs nommés par entrée, groupes, oubli à l'envoi.                          |
| `src/fields.tsx`     | `Input` et `Textarea` contrôlés et restaurables, `useRestoredFields` ; `runtime-context.ts` porte le contexte.                  |
| `src/session.ts`     | Fichier de session d'un Client (`$XDG_STATE_HOME/airtty/<app>/sessions`), reprise après crash, suppression.                     |
| `src/not-found.ts`   | Passage de `notFound()` à travers Flight (digest), partagé par le Server et le Client.                                          |
| `src/compile.ts`     | Client autonome en un exécutable (`airtty build --compile`) et runtime Bun officiel (`airtty runtime`).                         |
| `src/sign.ts`        | Signature Developer ID, hardened runtime et notarisation du Client macOS (`--sign`, `--notarize`).                              |
| `src/connect.ts`     | URL du Server côté Client (`--url` > `AIRTTY_URL` > `~/.config/airtty/<app>.json`), tunnel `ssh://` et socket `unix:`.          |
| `src/launcher/`      | `airtty <cible>` et binaires d'app : résolution, lancement local sur socket, git, `--on` ([DISTRIBUTION](DISTRIBUTION.md)).     |
| `src/registry/`      | Registre d'apps (`Registry`, npm), paquets par plateforme, apps installées dans `$XDG_DATA_HOME/airtty/apps`.                   |
| `src/guards.ts`      | Gardes de type Server/Client ; `package-json.ts` (JSON validé par Zod), `bundle-errors.ts` (échecs de Bun.build).               |
| `src/cache/`         | `"use cache"` ([CACHE.md](CACHE.md)) : transformation du build, clé, durées, tags, dédup, handlers mémoire et SQLite.           |
| `src/embed.tsx`      | `<Embed>`, `openApplication` : une autre application airtty par pane, keymap filtré, focus, boundary.                           |
| `src/vt/`            | `<Terminal>` : programme local sur PTY (`Bun.Terminal`) rendu par l'émulateur d'OpenTUI ; trous d'OpenTUI comblés (`gaps.ts`).  |
| `src/instance.ts`    | Clé d'instance d'un pane (`x-airtty-instance`) et copies préfixées du manifeste Client, bornées, côté Server.                   |
| `src/flight/`        | Adapter du vrai codec React Flight et contrat de résolution des modules Client.                                                 |
| `src/devtools/`      | DevTools (dev) : protocole, agents `AIRTTY_DEVTOOLS`, hook de fibers, app `airtty devtools` ; [DEVTOOLS.md](DEVTOOLS.md).       |

`tests/`, `probes/` et `scripts/` servent à développer et vérifier le framework.
Ils ne sont pas du code à recopier dans chaque application.

## Le code écrit par un développeur d’application

`examples/notes/` représente exactement cette partie :

```text
app/routeTree.gen.ts       route tree typé généré par le build, versionné
app/layout.tsx             layout racine persistant, "use client"
app/page.tsx               liste côté Server
app/notes/layout.tsx       layout imbriqué persistant entre les notes, "use client"
app/notes/[id]/page.tsx     chargement et composition d’une note
app/notes/[id]/loading.tsx  squelette local de la page pendant la navigation, "use client"
app/error.tsx              écran d'échec d'une page, avec son outcome, "use client"
components/NoteList.tsx    sélection/navigation locale, "use client"
components/NoteEditor.tsx  édition, raccourcis et événements locaux, "use client"
components/draft.ts        Drafts de session et résultats inconnus : politique de Notes
actions/notes.ts           fonctions métier appelables, "use server"
server/repository.ts       accès SQLite, droits et transactions
server/auth.ts             adapter d'identité optionnel
server/queries.ts          lectures mises en cache ("use cache"), étiquetées par tags
server/cache.ts            CacheHandler optionnel ; en mémoire par défaut
```

Le développeur remplace ces fichiers par ses pages, composants et règles métier.
Il utilise React et les composants OpenTUI, importe les hooks du framework et passe
les Server Functions en props ou les importe dans des Client Components. Il ne
rédige ni protocole RPC, ni registre de modules, ni manifest Flight, ni bootstrap
OpenTUI.

`server/auth.ts` est optionnel. Lorsqu'il existe, le build l'inclut uniquement dans
le graphe Server et injecte son `AuthConfig` dans le runtime. Les pages et actions
sont protégées par défaut ; `export const auth = "public"` est une exception locale
et explicite.

Dans Notes, la page Server charge une note et transmet `saveNote` au composant
`NoteEditor`. Le composant traite chaque frappe localement. À Entrée, il appelle
la référence de `saveNote` ; le framework encode l’appel via Flight, l’envoie au
Server et reçoit le résultat ; sur un succès, `NoteEditor` invalide la route montée
via TanStack Router pour afficher la nouvelle version.
SQLite reste côté Server. La navigation est décrite dans [ROUTER.md](ROUTER.md).

## Deux formes de distribution

**Pour l’auteur d’application**, le produit est le package `airtty` :
CLI `airtty`, entrées `/client`, `/server`, `/build` et configuration `/tsconfig`.
Aujourd’hui il est privé et local ; le starter utilise une dépendance `file:` vers
le checkout. La publication sur un registre et le nom définitif restent à faire.
Les outils TypeScript/Oxc accompagnent le développement.

**Pour l’utilisateur de l’application**, le build produit :

```text
sources de l’application + framework
                 │ airtty build
                 ├── .airtty/server/ → machine qui exécute le métier et garde la base
                 └── .airtty/client/ → terminal de l’utilisateur
                                          │
                                          └── HTTP/Flight vers un Server compatible
```

Le Client contient le runtime terminal et les Client Components de **cette
application**. Le Server contient le runtime HTTP, les routes, les actions et le
métier. Chacun embarque `index.js`, `package.json` et `bun.lock` ; installer ses
dépendances puis lancer Bun. Le Client n’a pas besoin des sources Server ni de la
base. Les deux artefacts doivent correspondre au même identifiant de build.

Le packaging actuel privilégie la reproductibilité : les manifests de dépendances
des deux rôles sont identiques et incluent aussi les outils de développement.
Réduire ces manifests et publier le package sont des travaux de packaging futurs.
Le code métier reste exclu du bundle Client malgré ce manifeste commun.

`airtty build --compile [--target …]` produit aussi le Client en un seul exécutable
(runtime Bun, bibliothèque native OpenTUI et build ID embarqués) : la machine du
terminal n'a besoin ni de Bun ni de `node_modules`. `airtty build` sans `--compile`
n'accède pas au réseau. `--compile` embarque par défaut le runtime Bun officiel de la
cible : le paquet npm `@oven/bun-<os>-<arch>` est téléchargé **une fois**, comparé à
l'`integrity` (sha512) publiée par le registre, extrait dans un répertoire temporaire
puis publié par un seul `rename` dans `$XDG_CACHE_HOME/airtty/runtime/` : une
interruption ne laisse pas d'entrée partielle. Les compilations suivantes n'utilisent
plus le réseau ; `airtty runtime` remplit ce cache à l'avance. `--runtime host`
embarque le Bun local (déconseillé s'il vient de Nix ou Homebrew, le build l'indique)
et `--runtime <chemin>` un exécutable choisi. L'empreinte protège contre une archive
tronquée ou modifiée en transit ; elle ne protège pas d'un registre compromis (les
signatures npm ne sont pas vérifiées). `--sign <identité>` et `--notarize <profil>`
(`src/sign.ts`) signent le binaire macOS (hardened runtime, entitlements minimaux de
Bun) et le font notariser ; rien n'est exigé par défaut. Voir
[probes/compile](../probes/compile/README.md).

`--compile` produit par défaut le binaire complet de l'app (Client et Server, voir
[DISTRIBUTION.md](DISTRIBUTION.md)) ; `--client-only` garde le Client seul.

Ce n’est pas encore un Client générique qui télécharge une application en ouvrant
une URL. Chaque application distribue son propre Client de confiance. L’interface
de résolution de modules laisse cette évolution possible, mais la distribution
dynamique et son modèle de confiance restent à décider.

Les Drafts et la reprise des opérations inconnues ne font plus partie du framework :
comme dans Electron, Qt ou .NET, le runtime rapporte l'issue de chaque requête
(`TransportError.outcome`) et l'application choisit sa politique. Notes et Forge
gardent chacune leur `components/draft.ts`. Une bibliothèque partagée ne sera extraite
que si le même code se répète dans une troisième application.

Le framework garde en revanche ce que garde un navigateur, puisque le Client en tient
le rôle : l'historique et le texte des champs nommés de chaque entrée, écrits dans un
fichier de session par Client. C'est un mécanisme sans sens métier : il ne sait ni ce
qu'est un Draft, ni comment régler un conflit ; il survit au rebuild de `airtty dev`,
à un crash et à un terminal fermé, et disparaît quand l'utilisateur quitte. Voir
[API.md](API.md#champs-restaurables).

## Points d'extension

Les chantiers qui s'ajoutent au framework (DevTools, cache, distribution, Client
générique) s'y branchent par ces points, dans leurs propres fichiers, sans modifier
`client.tsx`, `transport.ts`, `server.ts` ni `cli.ts` :

| Point                                                                   | Pour                                                                 |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `ApplicationOptions.wrapTransport`                                      | Décorer le `Transport` du Client : cache, enregistrement.            |
| `Application.onEvent` : `at`, `callId`, `cause`, `invalidate`, `loader` | Chronologie, corrélation Client/Server, doubles invalidations.       |
| `serve({ instrument })`, `ServerEvent`                                  | Événements Server par `callId` ; emplacement des futurs middlewares. |
| `src/commands/<nom>.ts` + une ligne dans `src/commands/index.ts`        | Nouvelle sous-commande `airtty <nom>` (`Command { usage, run }`).    |
