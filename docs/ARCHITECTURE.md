# Structure et distribution

Le dépôt est un espace de travail Bun (`workspaces` du `package.json` racine) :

| Répertoire          | Contenu                                                                                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/airtty/`  | Le framework, package `airtty` : `src/`, `tsconfig.base.json` (exporté `airtty/tsconfig`), `types.d.ts`, `native/airtty-sandbox` (Rust), `web/` (patch OpenTUI du runtime navigateur).                |
| `packages/desktop/` | Prototype d'app desktop (Electrobun, xterm.js) : le binaire d'une app sur un PTY, dans une fenêtre ([DESKTOP](DESKTOP.md)).                                                                           |
| `packages/harness/` | Paquet privé `@airtty/harness` : adaptateurs des agents de code (Claude Code, Codex, pi, opencode, scripté), modèle neutre, `HarnessSession`, composants du transcript ; partagé par coder et studio. |
| `examples/<app>/`   | Une application par dossier, chacune un package qui déclare `airtty` (`workspace:*`) et les paquets qu'elle importe (`catalog:`).                                                                     |
| `tests/`            | Tests d'intégration du framework, qui construisent et lancent les exemples.                                                                                                                           |
| `scripts/`          | Parcours PTY, installation neuve, conteneurs Linux, build du sandbox, parcours navigateur (`scripts/web/`).                                                                                           |
| `probes/`           | Sondes historiques, hors espace de travail ; celles qui ont des dépendances gardent leur propre lockfile.                                                                                             |
| `website/`          | Page de présentation (Astro), hors espace de travail, avec son propre lockfile ; écrans capturés des exemples.                                                                                        |

Le catalogue (`workspaces.catalog`) fixe une version par paquet pour la racine et les
exemples. `airtty` garde des versions exactes plutôt que `catalog:` : un starter hors de
l'espace de travail l'installe par `file:`, où le catalogue n'existe pas ;
`tests/dependencies.test.ts` vérifie que les deux sources donnent les mêmes versions. Le
linker reste `hoisted` (`bunfig.toml`) : un seul `node_modules`, à la racine.

Dans la suite de la documentation et dans les commentaires du code, `src/…` et
`native/…` désignent `packages/airtty/src/…` et `packages/airtty/native/…`. Chaque
application est une codebase unique ; son build produit deux programmes.

## Le framework que nous développons

| Fichier                 | Responsabilité                                                                                                                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/cli.ts`            | Arguments ; les sous-commandes sont listées dans `src/commands/index.ts`. Une cible qui n'en est pas une (`airtty ./notes`, une URL) va au launcher.                                                                                                |
| `src/commands/`         | Une sous-commande par module : init, dev, build, start/connect, runtime, keys, trust, apps (search, install, update, list, remove), pack, devtools, web-runtime ; `launch` par défaut.                                                              |
| `src/dev/supervisor.ts` | Supervision d'une app en développement, partagée par `airtty dev` et les hôtes qui décident eux-mêmes du rebuild (studio) : démarrage du Server jusqu'à sa ligne `ready`, bearer d'un Client au suivant, rebuilds jamais simultanés (`airtty/dev`). |
| `src/build.ts`          | Lecture de l’AST, graphes Client/Server, validation des frontières, références Flight, routes, manifests et bundles.                                                                                                                                |
| `src/route-graph.ts`    | Compilation pure de `app/` en route graph : layouts, pages, groupes, params, catch-all, loading/error/not-found.                                                                                                                                    |
| `src/server.ts`         | Handler HTTP (`createHandler`), contexte de session, registre des pages, Server Functions, `notFound()`, `invalidate()`, réponses live.                                                                                                             |
| `src/serve.ts`          | `serve()` : le Server comme processus qui écoute (port ou socket privée), environnement, refus d'une écoute exposée sans authentification, signaux.                                                                                                 |
| `src/run.tsx`           | `run()` : une Application dans son terminal (environnement, signaux, superviseur de `airtty dev`, fichier de session, renderer TTY).                                                                                                                |
| `src/route-tree.tsx`    | Fabriques de routes de `app/routeTree.gen.ts` : layouts, pages, loaders Flight, écrans error/not-found, Échap.                                                                                                                                      |
| `src/transport.ts`      | Interface `Transport` et adapter HTTP/Flight : build ID, bearer, timeout, `outcome`, événements, réseau simulé.                                                                                                                                     |
| `src/client.tsx`        | `Application` et `Shell` : TanStack Router, keymap, loaders Flight, actions, invalidation, live, observabilité, hooks.                                                                                                                              |
| `src/restore.ts`        | Session façon navigateur : historique et texte des champs nommés par entrée, groupes, oubli à l'envoi.                                                                                                                                              |
| `src/fields.tsx`        | `Input` et `Textarea` contrôlés et restaurables, `useRestoredFields` ; `runtime-context.ts` porte le contexte.                                                                                                                                      |
| `src/session.ts`        | Fichier de session d'un Client (`$XDG_STATE_HOME/airtty/<app>/sessions`), reprise après crash, suppression.                                                                                                                                         |
| `src/not-found.ts`      | Passage de `notFound()` à travers Flight (digest), partagé par le Server et le Client.                                                                                                                                                              |
| `src/compile.ts`        | `airtty build --compile` : binaire d'app (Client et Server) ou Client seul (`--client-only`) ; runtime Bun officiel (`airtty runtime`).                                                                                                             |
| `src/sign.ts`           | Signature Developer ID, hardened runtime et notarisation du Client macOS (`--sign`, `--notarize`).                                                                                                                                                  |
| `src/generic/`          | Client générique (`airtty <url>`) : origine, épinglage de la clé, mode, cache des bundles (`prepare.ts`), app hôte à onglets (`browser/`).                                                                                                          |
| `src/publisher.ts`      | Clé d'éditeur Ed25519 des bundles d'application (`airtty keys`, `--sign-bundle`), signature canonique du manifeste. Pas Developer ID.                                                                                                               |
| `src/app-routes.ts`     | `GET /manifest` et `GET /bundle/<sha256>` du Server, publics, lus une fois au démarrage ; 404 sans bundle.                                                                                                                                          |
| `src/connect.ts`        | URL du Server côté Client (`--url` > `AIRTTY_URL` > `~/.config/airtty/<app>.json`), tunnel `ssh://` et socket `unix:`.                                                                                                                              |
| `src/launcher/`         | `airtty <cible>` et binaires d'app : résolution, lancement local sur socket, git, `--on` ([DISTRIBUTION](DISTRIBUTION.md)).                                                                                                                         |
| `src/registry/`         | Registre d'apps (`Registry`, npm), paquets par plateforme, apps installées dans `$XDG_DATA_HOME/airtty/apps`.                                                                                                                                       |
| `src/guards.ts`         | Gardes de type Server/Client ; `package-json.ts` (JSON validé par Zod), `bundle-errors.ts` (échecs de Bun.build).                                                                                                                                   |
| `src/cache/`            | `"use cache"` ([CACHE.md](CACHE.md)) : transformation du build, clé, durées, tags, dédup, handlers mémoire et SQLite.                                                                                                                               |
| `src/abi.ts`            | ABI de runtime des bundles d'application : spécifiers, versions, clé ; schéma de `.airtty/app/manifest.json`.                                                                                                                                       |
| `src/app-bundle.ts`     | `openApplication` : vérifie et évalue un bundle d'application contre le runtime de l'hôte (table `require` de l'ABI).                                                                                                                               |
| `src/capabilities.ts`   | `airtty.capabilities` (schéma Zod partagé) et comparaison avec les built-ins requis par le Client.                                                                                                                                                  |
| `src/app-metadata.ts`   | `airtty.displayName`, `identifier`, `icon` du `package.json` : vérifiés, écrits dans `.airtty/metadata.json`.                                                                                                                                       |
| `src/embed.tsx`         | `<Embed>`, `openApplication` : une autre application airtty par pane, keymap filtré, focus, boundary.                                                                                                                                               |
| `src/vt/`               | `<Terminal>` : programme local sur PTY (`Bun.Terminal`) rendu par l'émulateur d'OpenTUI ; trous d'OpenTUI comblés (`gaps.ts`).                                                                                                                      |
| `src/instance.ts`       | Clé d'instance d'un pane (`x-airtty-instance`) et copies préfixées du manifeste Client, bornées, côté Server.                                                                                                                                       |
| `src/flight/`           | Adapter du vrai codec React Flight et contrat de résolution des modules Client.                                                                                                                                                                     |
| `src/host.ts`           | `host` (`airtty/client`) : ce qu'une application demande à son hôte (presse-papiers, notifications, URL, secrets) ; `host-direct.ts` y répond avec les droits de l'utilisateur, `host-hooks.ts` fournit les hooks.                                  |
| `src/app-evaluate.ts`   | Évaluation d'un bundle d'application contre ce runtime, sans lecture disque : contrôles, table `require` de l'ABI ; partagée avec le runtime web.                                                                                                   |
| `src/sandbox/`          | Mode `sandbox` du Client générique : mécanisme (Seatbelt, espaces de noms, bubblewrap), profil, proxy de sortie, IPC avec l'hôte.                                                                                                                   |
| `src/native.ts`         | Packages Server à code natif : gardés hors du bundle, disposés à côté du binaire d'app.                                                                                                                                                             |
| `src/build-names.ts`    | Noms des composants et hooks écrits par le build, pour les DevTools et les messages de React.                                                                                                                                                       |
| `src/framework-hash.ts` | Empreinte du framework (sources et lockfile) ; `lockfile.ts` trouve le `bun.lock` qui gouverne une installation.                                                                                                                                    |
| `src/web/`              | Runtime navigateur ([WEB](WEB.md)) : page, OpenTUI en WebAssembly, xterm.js, substituts Node, Server en SharedWorker pour `--web-local`.                                                                                                            |
| `src/web-routes.ts`     | Pages du runtime web servies à la seule origine `AIRTTY_WEB_ORIGIN` ; refus des autres origines de navigateur.                                                                                                                                      |
| `src/web-runtime.ts`    | Préparation du runtime web, une fois par framework dans `$XDG_CACHE_HOME/airtty/web/`, copiée par `airtty build --web`.                                                                                                                             |
| `src/airttyx.ts`        | `airttyx <cible>` : résout, installe au besoin et lance, comme npx ; la cible n'est jamais une sous-commande.                                                                                                                                       |
| `src/devtools/`         | DevTools (dev) : protocole, agents `AIRTTY_DEVTOOLS`, hook de fibers, app `airtty devtools` ; [DEVTOOLS.md](DEVTOOLS.md).                                                                                                                           |

`tests/`, `probes/` et `scripts/` servent à développer et vérifier le framework.
Ils ne sont pas du code à recopier dans chaque application.

## Le code écrit par un développeur d’application

`examples/notes/` représente cette partie :

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
components/NoteFrame.tsx   présentation partagée par la page Server et le squelette
components/draft.ts        Drafts de session et résultats inconnus : politique de Notes
actions/notes.ts           fonctions métier appelables, "use server"
server/repository.ts       accès SQLite, droits et transactions
server/schemas.ts          validation Zod des arguments reçus
server/queries.ts          lectures mises en cache ("use cache"), étiquetées par tags
server/tags.ts             tags de cache des lectures
```

Deux fichiers optionnels sont absents de Notes : `server/auth.ts`, adapter d'identité
(Forge en fournit un), et `server/cache.ts`, `CacheHandler` choisi par l'application
(en mémoire par défaut, voir [CACHE.md](CACHE.md)).

Le développeur remplace ces fichiers par ses pages, composants et règles métier.
Il utilise React et les composants OpenTUI, importe les hooks du framework et passe
les Server Functions en props ou les importe dans des Client Components. Il ne
rédige ni protocole RPC, ni registre de modules, ni manifest Flight, ni bootstrap
OpenTUI.

`app/args.ts` est optionnel aussi : il déclare les options de ligne de commande de
l'application (`defineArgs`, `airtty/args`). Chaque point d'entrée les vérifie et les
transmet au Server, qui les reparse et fait autorité ; invariant : **un Server = un jeu
d'arguments**, une constante de son process. Le Client ne les lit pas : la page lui passe
en props ce dont l'UI a besoin ([API.md](API.md#arguments-de-lapplication)).

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
CLI `airtty` et `airttyx`, entrées `/client`, `/server`, `/route-tree`, `/args`, `/build`,
`/pty`, `/metadata` et configuration `/tsconfig`.
Aujourd’hui il est privé et local ; le starter utilise une dépendance `file:` vers
le checkout. La publication sur un registre et le nom définitif restent à faire.
Les outils TypeScript/Oxc accompagnent le développement.

**Pour l’utilisateur de l’application**, le build produit :

```text
sources de l’application + framework
                 │ airtty build
                 ├── .airtty/server/ → machine qui exécute le métier et garde la base
                 ├── .airtty/client/ → terminal de l’utilisateur
                 │                        │
                 │                        └── HTTP/Flight vers un Server compatible
                 └── .airtty/app/    → bundle d'application sans runtime, pour un hôte
                                       (`openApplication`, `<Embed>`)
```

`.airtty/app/` contient `index.cjs` (format `bun-cjs`, les spécifiers de l'ABI
`src/abi.ts` laissés à l'hôte) et `manifest.json` : buildId, clé d'ABI, sha256, built-ins
Node requis, `airtty.capabilities` du `package.json` de l'application (comparées aux
built-ins, avec un avertissement). Du Client code avec un top-level await (que CommonJS
n'exprime pas) : le build réussit sans `.airtty/app/` et le signale (fichier:ligne) ;
`airtty build --app-bundle` en fait un échec. `airtty build --sign-bundle` signe le
manifeste avec la clé d'éditeur Ed25519 (`airtty keys`), sur un encodage canonique de ses
champs ; le Server sert `GET /manifest` et `GET /bundle/<sha256>` (immuable), sans session
ni en-tête de build.

Le Client contient le runtime terminal et les Client Components de **cette
application**. Le Server contient le runtime HTTP, les routes, les actions et le
métier. Chacun est un `index.js` qui s’exécute depuis l’installation de l’application :
React, React Server DOM et OpenTUI restent externes et s’y résolvent. Le Client n’a pas
besoin des sources Server ni de la base. Les deux artefacts doivent correspondre au
même identifiant de build.

`.airtty/client` et `.airtty/server` ne sont pas une forme de livraison : ils
n’embarquent ni manifeste ni lockfile à installer ailleurs. Une machine dont on connaît
la plateforme reçoit un binaire compilé (ci-dessous) ; une cible inconnue part de la
source (`airtty git+…`), installée depuis son `bun.lock` et buildée sur place.

L’identifiant de build inclut le `bun.lock` qui gouverne l’installation
(`src/lockfile.ts` : le plus proche au-dessus du framework, puis de l’application,
sans dépasser le checkout git) : le checkout du framework, la racine d’un espace de
travail, ou l’application qui a installé `airtty`. Ce fichier liste les paquets de
toutes les plateformes, contrairement à `node_modules` : un Server Linux et un Client
macOS compilés depuis les mêmes sources partagent le même identifiant, ce que `--on`
exige.

`airtty build --compile [--target …]` produit aussi un seul exécutable (runtime Bun,
bibliothèque native OpenTUI et build ID embarqués) : par défaut le binaire complet de
l'app, Client et Server (voir [DISTRIBUTION.md](DISTRIBUTION.md)) ; `--client-only`
garde le Client seul. La machine du terminal n'a besoin ni de Bun ni de `node_modules`.

`airtty build` sans `--compile` ni `--web` n'accède pas au réseau ; la première
préparation du runtime web (`--web`) clone OpenTUI avec git et le compile avec Zig.
`--compile` embarque par défaut le runtime Bun officiel de la cible : le paquet npm
`@oven/bun-<os>-<arch>` est téléchargé **une fois**, comparé à l'`integrity` (sha512)
publiée par le registre, extrait dans un répertoire temporaire puis publié par un seul
`rename` dans `$XDG_CACHE_HOME/airtty/runtime/` : une interruption ne laisse pas
d'entrée partielle. Les compilations suivantes n'utilisent plus le réseau ; `airtty
runtime` remplit ce cache à l'avance. `--runtime host` embarque le Bun local
(déconseillé s'il vient de Nix ou Homebrew, le build l'indique) et `--runtime <chemin>`
un exécutable choisi ; `--portable` fait de cet avertissement une erreur, avant de
compiler, pour un binaire destiné à d'autres machines. L'empreinte protège contre une
archive tronquée ou modifiée en transit ; elle ne protège pas d'un registre compromis
(les signatures npm ne sont pas vérifiées). `--sign <identité>` et `--notarize <profil>`
(`src/sign.ts`) signent le binaire macOS (hardened runtime, entitlements minimaux de
Bun) et le font notariser ; rien n'est exigé par défaut. Voir
[probes/compile](../probes/compile/README.md).

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
