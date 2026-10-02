# Client générique et applications embarquées

Statut : étapes 1 à 8 livrées (voir [Avancement](#avancement)) ; la conception ci-dessous
s'appuie sur quatre prototypes jetables exécutés le 24 septembre 2026 (macOS 26.6.2 arm64,
Bun 1.4.2) : inline, generic-client, vt-embed et sandbox (retirés du dépôt ; leurs mesures
sont reprises ci-dessous et leur code vit dans `packages/core/src`).

Objectif : un Client luciole capable d'ouvrir plusieurs applications à la fois, comme un
navigateur à onglets ou un multiplexeur local (tmux, herdr) : applications luciole
téléchargées depuis leur Server, applications installées, shells, vim.

Un utilisateur de cette conception : l'aperçu en direct de studio, qui embarque en
`sandbox` une application générée par un harness et confine aussi son Server
([DESIGN.md](../examples/studio/DESIGN.md)).

Les décisions prises sur la conception sont regroupées en [section 8](#8-décisions) ;
le reste du document en tient compte.

## 1. Modèle

### L'origine

Une **origine** est ce qui reçoit des droits : l'URL d'un Server (schéma, hôte, port,
telle que l'utilisateur l'a donnée, pas l'adresse locale d'un tunnel), un paquet installé
(chemin + clé de l'éditeur) ou une commande locale (`$SHELL`, `vim`). Les droits, la clé
épinglée, le stockage et les jetons sont rangés par origine.

### Trois modes d'isolation, un curseur par origine

| Mode      | Où tourne l'application                                       | Isolation                     | Rendu                        | Pour                                           |
| --------- | ------------------------------------------------------------- | ----------------------------- | ---------------------------- | ---------------------------------------------- |
| `inline`  | dans le processus du Client, même arbre React                 | aucune                        | direct, focus/thème partagés | code de confiance : local, installé, signé     |
| `process` | processus enfant, sans sandbox                                | crashs uniquement             | widget VT (PTY + émulateur)  | multiplexeur local : shells, vim, apps luciole |
| `sandbox` | processus enfant sous sandbox OS (Seatbelt ; luciole-sandbox) | crashs + capacités appliquées | widget VT                    | URL distante, paquet non signé                 |

Défauts : local ou installé → `process` ; URL distante ou paquet non signé → `sandbox`.
L'utilisateur surcharge (réglage mémorisé par origine, ou flag CLI) ; l'application
jamais. `inline` est un choix explicite de l'utilisateur pour une origine de confiance.
`process` n'ajoute **aucune** couche de sécurité : c'est tmux, pas un navigateur.

### Capacités

À la Deno : `fs.read`/`fs.write` par chemin, `net` par hôte, `exec` (par binaire) et
`pty`, `clipboard.read`/`clipboard.write`, `notify`, `open-url`, `secrets`,
`input.global`, `tabs.message`. Déclarées **statiquement** dans le champ
`luciole.capabilities` du `package.json` de l'application (décision 3), lisible avant
toute exécution ; le lanceur définit déjà le champ `luciole` (`name`, `buildId`,
`binaries`), `capabilities` s'y ajoute avec le schéma Zod défini dans
`packages/core/src/capabilities.ts`. Le build recopie ce champ dans le manifeste signé
(section 2) : une origine URL les annonce sans que le Client lise le `package.json`, et
une application installée les donne par son `package.json`. Le build compare ce champ à
l'audit des built-ins Node du bundle Client (`fs/*` → `fs.*`, `child_process` → `exec`,
`net`/`http`/`tls` → `net`) et signale ce qui est utilisé sans être déclaré. Les
capacités sont accordées par l'utilisateur ou par flag (`--allow-net=api.example.com`),
mémorisées par origine.

Règle d'affichage, vérifiée par le probe sandbox : **une capacité n'est présentée comme
appliquée que si quelqu'un l'applique**. En `sandbox`, chaque capacité accordée a une
ligne qui dit qui l'applique (OS, proxy, hôte). En `process`, l'écran d'origine dit
« aucune isolation ». En `inline` (décision 5), tout est permis, y compris
`child_process` : le lanceur l'affiche explicitement avant l'ouverture, par exemple
« inline : confiance totale, ce code a tous les droits de votre compte ; capacités
déclarées, non appliquées : fs.read, exec… ». Aucun interrupteur par capacité n'est
proposé dans ces deux modes. Tout accorder équivaut à passer en `process` : le Client
le propose au lieu de simuler une sandbox vide.

Qui applique quoi (mesuré) :

| Capacité                                         | macOS                                                                      | Linux                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `fs.read`, `fs.write`                            | OS (Seatbelt, par chemin)                                                  | Landlock (+ montages bwrap sous bubblewrap)                             |
| `net` par hôte                                   | proxy de l'hôte ; l'OS limite l'enfant au port du proxy                    | proxy ; espace de noms réseau (userns, bwrap) ; refusé en Landlock seul |
| `net: *`                                         | OS                                                                         | OS                                                                      |
| `exec` (par binaire, hérité par les descendants) | OS                                                                         | Landlock ; bwrap sans Landlock : refusé                                 |
| `pty`                                            | refusée en sandbox : `/dev/ttys*` ouvrirait les autres terminaux (étape 7) | devpts privé (userns, bwrap) ; refusé en Landlock seul                  |
| `clipboard.*`, `notify`, `open-url`, `secrets`   | hôte : la voie directe (mach-lookup) est bloquée par l'OS                  | hôte : seccomp refuse les sockets Unix (D-Bus, Wayland, X11)            |
| `input.global`, `tabs.message`                   | hôte (IPC)                                                                 | hôte (IPC)                                                              |

Seatbelt ne connaît que `*` et `localhost` comme hôte distant : un nom ou une IP dans le
profil est une erreur de compilation du profil (vérifié). Le filtrage par hôte passe donc
toujours par un proxy de sortie tenu par l'hôte ; l'enfant ne résout même pas le DNS.

## 2. Client générique : runtime et bundle d'application

Aujourd'hui chaque application distribue son propre Client : `.luciole/client/index.js`
embarque le runtime luciole, TanStack Router et le keymap ; seuls React, OpenTUI et Flight
sont external (`src/build.ts`). Un Client générique inverse la relation.

Point d'entrée (décision 2) : pas de nouvelle commande. `luciole https://…` passe par le
lanceur (`src/launcher/`), qui résout son argument dans l'ordre chemin → installé →
npm → git → URL. Le Client générique se branche sur la dernière étape (URL :
`GET /manifest`, puis ce qui suit) ; les étapes installé, npm et git fournissent un
paquet dont le `package.json` porte déjà `luciole` (`name`, `buildId`, `binaries`,
`capabilities`), et le même chargeur évalue son bundle sans téléchargement.

- **Runtime** : React, OpenTUI, keymap, TanStack Router, Zod, le runtime luciole. Compilé
  dans le binaire du Client générique. Il doit lui-même être un artefact de build : la
  redirection `@tanstack/router-core/isServer` → `client.js` de `src/build.ts` s'y
  applique (probe : 292 Ko, 68 Ko gzip, sans React/OpenTUI).
- **Bundle d'application** : les Client Components, le route tree généré, les stubs
  `"use server"`, les dépendances propres à l'application. Tout le reste est un
  `require` résolu par l'hôte (probe : mdreader 20 Ko, 7,5 Ko gzip ; files 29 Ko).
- **ABI de runtime** : la liste fermée des spécifiers que le bundle peut importer
  (`@luciole-sh/core/client`, `@luciole-sh/core/route-tree`, `@tanstack/react-router`, `react`,
  `react/jsx-runtime`, `@opentui/core`, `@opentui/react`, `@opentui/react/jsx-runtime`,
  `@opentui/keymap`, `@opentui/keymap/react`, `zod`, `zod/mini`), une version entière
  incrémentée à la main quand un export d'`@luciole-sh/core/client` change de façon incompatible, et
  les versions exactes des paquets. Clé : `<version>-<sha256 court>`, écrite dans le
  manifeste, comparée **avant** le téléchargement.
- **Format** : `bun-cjs`, `(function (exports, require, module, …) {…})`. L'hôte passe
  son propre `require` : cette table _est_ l'ABI, sans `node_modules` côté Client ni
  résolution disque ; chaque évaluation est une instance de module neuve (≈ 2–3 ms pour
  mdreader). Un module applicatif avec `await` au niveau supérieur n'est pas exprimable :
  le build le refuse.
- **Built-ins Node** : lus dans le metafile du bundler (Bun les externalise avant tout
  plugin). `files` demande `crypto`, `fs/promises`, `path`, `url`. Ils sont listés dans le
  manifeste ; l'hôte refuse un `require` non déclaré. Ce n'est **pas** une sandbox : en
  `inline`, le code a les droits du processus ; la liste sert à l'affichage et à choisir
  le mode.

### Confiance

Le manifeste (`GET /manifest`) lie buildId, sha256 et taille du bundle, clé ABI,
built-ins et clé publique Ed25519 de l'éditeur ; la signature porte sur un encodage
canonique (tableau ordonné), jamais sur le JSON reçu. Le Client :

1. vérifie la signature ;
2. épingle la clé au premier usage par origine (TOFU, comme `known_hosts`) et refuse
   ensuite toute autre clé ;
3. compare la clé ABI ;
4. lit le bundle dans le cache par sha256, sinon `GET /bundle`, vérifie le hash, publie
   le fichier par `rename` ;
5. évalue, puis vérifie que le bundle exporte le buildId signé (le Transport enverra ce
   buildId dans `x-luciole-build`, que le Server vérifie déjà).

Probe : altération d'un octet, manifeste modifié après signature, clé changée, ABI
différente, `require` hors ABI : tous refusés avant évaluation. Démarrage à chaud
(manifeste + vérification + cache) < 1,3 ms en loopback ; à froid jusqu'à la première
frame complète de mdreader ≈ 200 ms, dont l'essentiel est le rendu Server.

### Stockage partitionné

Tout ce que le Client écrit est rangé sous l'origine : sessions (`src/session.ts` range
aujourd'hui par nom d'application : `$XDG_STATE_HOME/luciole/<app>/sessions`), bearer,
configuration (`src/connect.ts` : `~/.config/luciole/<app>.json`), cache des bundles
(partagé par hash, sans risque), clés épinglées, capacités accordées. Proposition :
`$XDG_STATE_HOME/luciole/origins/<sha256(origine)>/` et le cache sous
`$XDG_CACHE_HOME/luciole/bundles/<sha256>.cjs`.

## 3. Obstacles dans `src/` et refactors proposés

Le probe inline monte `examples/mdreader` et `examples/files` côte à côte dans un seul
processus et mesure chaque obstacle (état de `src/` avant l'étape 1), puis le même
scénario avec les refactors appliqués depuis l'extérieur de `src/`
(prototype generic-client) : tout passe.

### O1. Un seul résolveur de modules par processus

`src/flight/client.ts` installait **un** `__webpack_require__` global dont la fonction
`resolve` était remplacée par chaque `installResolver`, appelé par chaque
`new Application`. Mesuré : la seconde application montée gagne ; la page de la
première affiche « Unknown module …/components/Reader.tsx ».

Deux faits contraignent la solution :

- le codec Flight navigateur (`client.browser`) crée ses réponses avec une table de
  modules `null` : impossible de lui passer une table par réponse ; `client.edge` et
  `client.node` acceptent une table mais n'ont pas de `callServer` ;
- la résolution est **paresseuse** : `requireModule` s'exécute pendant le rendu React
  (`React.lazy`), longtemps après le décodage. Aucun « résolveur de la réponse courante »
  n'est fiable.

L'id doit donc porter le pane qui le résout. Le buildId que `src/build.ts` met déjà
en tête de chaque id ne suffit pas : deux panes de la même application (le cas du
multiplexeur, ou deux origines servant le même build) partagent alors une entrée. Mesuré
(`panes/build`) : les Client References du premier pane sont résolues avec l'instance de
modules du second, et ses Server Functions importées partent par l'Application du
second.

**Décision 4 : préfixe par instance, dès maintenant.** Chaque pane reçoit une clé
d'instance (`p1`, `p2`…, `[a-z0-9-]{1,32}`), que son Transport envoie dans
`x-luciole-instance` à chaque requête. Le Server écrit les Client References de la réponse
`<clé>@<buildId>/<chemin>` : Flight lit `manifest[id].id` pour chaque référence, il suffit
de lui passer une copie du manifeste préfixée par la clé. Sans en-tête, les ids restent
ceux d'aujourd'hui : le Client actuel ne change pas. Les ids de Server Functions ne
changent pas (le Server les connaît ainsi). Mesuré (`panes/instance`, Server patché depuis
l'extérieur de `src/`) : deux panes de mdreader contre
deux Servers affichent chacun son document, résolvent avec leurs propres modules et
envoient leurs actions par leur propre Application.

**Refactor** :

- `src/flight/client.ts` (≈ 30 lignes) : un registre `clé → resolver` ;
  `installResolver(next)` devient `registerModules(key, resolver): () => void`, le global
  aiguille sur le préfixe `<clé>@`, et sans préfixe sur l'unique résolveur enregistré (le
  Client actuel).
- `src/transport.ts` (≈ 3 lignes) : l'en-tête `x-luciole-instance` quand
  `HttpTransportOptions.instance` est défini ; `ApplicationOptions.instance` le transmet.
  Réglé par l'hôte (`<Embed>`, Client générique), jamais par l'application.
- `src/server.ts` (≈ 15 lignes) : l'en-tête validé par Zod, une copie préfixée du
  manifeste par clé passée à `renderToReadableStream`. La clé est choisie par le Client :
  les copies sont gardées dans un cache borné (ou calculées par un `Proxy` sans cache),
  jamais sans limite.
- Le build ne change pas.

### O2. `let current: Application`

`src/client.tsx` : les stubs générés pour les modules `"use server"` importés par un
Client Component (`src/build.ts`) appelaient `actionReference(id)`, qui passait par
`current`, la dernière Application construite. Les références reçues **par Flight** (Server Function passée en prop par une page) ne
sont pas concernées : elles utilisent le `callServer` de leur réponse. Mesuré :
`useLive(watchLibrary)` de mdreader part vers le Server de files.

**Refactor** (`src/client.tsx`, ≈ 20 lignes) : les ids d'action ne portent pas la clé
d'instance, l'aiguillage par préfixe est donc exclu ici. Chaque pane évalue son bundle
avec sa propre table `require` : son `@luciole-sh/core/client` a un `actionReference` lié à
l'Application du pane (c'est ce que fait le probe). `current` disparaît au profit de
cette liaison ; le Client actuel, un seul pane, lie l'unique Application, et ne change
pas de comportement.

Une **Application par pane**, chacune avec son Transport (déjà par instance), son
routeur en memory history (déjà), son `Restoration`, son bearer (déjà), ses listeners.
Le reste de l'état « par processus » vit dans `run()` (`src/run.tsx` : signaux,
session, supervision `luciole dev`) : il reste au niveau du Client hôte, pas des embeds.

### O3. Clavier et focus

`Shell` (`src/client.tsx`) créait un keymap sur le renderer entier. Mesuré avec
deux `Shell` : le dernier créé passe en premier (`prependListener`) et consomme les
touches qu'il lie (`Ctrl+R` ne rafraîchit que files) ; les touches qu'il ne lie pas
tombent dans l'autre application (`[` navigue dans mdreader alors que l'utilisateur est
dans files).

**Refactor** : un keymap par embed, construit sur un `KeymapHost` qui n'écoute que si
l'embed a les touches (probe : 40 lignes, `scopedHost`). Les couches `focus` et
`focus-within` des applications fonctionnent sans changement. La bascule entre embeds
appartient à l'hôte (touche préfixe à la tmux, réservée avant tout keymap d'application).

Le focus OpenTUI est global au renderer. Un `<input focused>` d'un embed inactif
recevrait encore la frappe (le renderer route la touche au renderable focalisé, hors
keymap). `<Embed>` met donc le focus de côté à la bascule et le rend au retour (étape 2).

API publique (décision 1) : un nouvel export `<Embed>` dans `@luciole-sh/core/client`, `Shell`
reste inchangé. Forme proposée, celle du probe (`EmbedShell`) :
`<Embed app={Application} name={string} active={boolean} />`, qui porte le keymap du
pane, sa boundary et le rendu du focus à la bascule.

### O4. Une erreur de rendu efface tout

`createRoot` d'OpenTUI pose une error boundary à la racine : un rendu qui jette dans une
application remplace l'écran entier (mesuré). **Refactor** : une boundary par embed dans
`<Embed>` ; l'erreur n'atteint jamais la racine.

### O5. Le build n'a qu'une sortie Client

`src/build.ts` générait un Client complet. **Refactor** : une seconde sortie
`.luciole/app/` (bundle `bun-cjs` sans runtime + `manifest.json` signé, qui recopie
`luciole.capabilities` du `package.json`), produite par la même passe (les graphes, les
ids et les stubs sont déjà calculés) ; la validation des frontières est inchangée. Le probe la reconstruit en 130 lignes hors de `src/` en
relisant `.luciole/manifest.json`.

### O6. Le Server ne sert pas de bundle

Deux routes `GET` dans `serve()` (`src/server.ts`), sans session ni `x-luciole-build`
(elles servent justement à l'obtenir) : `/manifest` (JSON signé) et `/bundle` (octets,
`cache-control: immutable` car adressés par hash). Le probe les sert par un relais devant
le Server ; les flux render/action/live traversent le relais sans tampon.

## 4. Modes `process` et `sandbox` : widget VT

Un enfant `process` ou `sandbox` est un programme terminal ordinaire (shell, vim, ou un
Client luciole lancé par `run()`, sans modification) ; l'hôte l'affiche dans un widget VT.
Probe : 15/15 assertions (shell, vim, application OpenTUI enfant, deux vues côte à côte).

- **PTY** : `Bun.Terminal` (Bun 1.4.2), sans dépendance. `detached: true` est
  obligatoire : sans lui le PTY n'est pas le terminal de contrôle, `Ctrl+C`
  n'interrompt pas un `sleep 30` et le shell avertit « no job control ».
- **Émulateur** : OpenTUI 0.5.12 embarque déjà libghostty-vt dans sa bibliothèque native,
  exposée en `EmbeddedTerminalRenderable`. Retenu : aucune dépendance à télécharger ou à
  signer, composition native.

| Émulateur                    | Débit (Mo/s) | Frame 80×24 / 200×60 | Mémoire / instance | Fidélité | Verdict                            |
| ---------------------------- | ------------ | -------------------- | ------------------ | -------- | ---------------------------------- |
| OpenTUI intégré (libghostty) | 55–107       | 61 / 367 µs          | ≈ 2 Mo             | 13/16    | **retenu**, avec `gaps.ts`         |
| libghostty-vt (FFI)          | 61–93        | 1,1 / 8,6 ms         | 1,2 Mo             | 14/16    | lecture hors rendu (tests)         |
| @xterm/headless              | 28–57        | 96 / 303 µs          | 2,5 Mo             | 12/16    | lecture hors rendu, portable       |
| ghostty-web (wasm)           | 28–56        | 70 / 425 µs          | 14 Mo              | 11/16    | **écarté** : fuite entre instances |
| ghostty-opentui              | 39–128       | 179 / 250 µs         | 2,5 Mo             | 8/16     | rendu de logs, pas un terminal     |

ghostty-web partage mal son instance WebAssembly : un terminal neuf a affiché le contenu
d'un terminal libéré (`BECRET-FROM-A`), puis planté. Rédhibitoire pour un multiplexeur
qui mélange des origines. Rendre la grille en `<text>`/`<span>` React coûte 12 à 20 fois
la composition native.

Dans le widget complet : écho d'une frappe ≈ 11–12 ms, vim prêt ≈ 94–202 ms, une
application OpenTUI enfant prête ≈ 91 ms, `seq 1..100000` à 16 Mo/s (limité par le shell
et le PTY). Taille du PTY = boîte intérieure ; le redimensionnement atteint le programme
(`stty size`).

Trous d'OpenTUI 0.5.12, à remonter en amont, comblés dans `packages/core/src/vt/gaps.ts` :
sans protocole clavier kitty, F1–F12, `Alt+x` et Backspace n'envoient rien ; DA1, DA2 et
OSC 10/11 restent sans réponse ; OSC 8 (hyperliens) n'apparaît pas dans le rendu (non
comblé).

Conséquence pour l'hôte : les raccourcis globaux passent avant le terminal focalisé. Le
keymap d'une application (ou de l'hôte) volerait les touches du terminal embarqué ; seule
la touche préfixe de l'hôte (`Ctrl+O` dans le probe) doit être réservée, jamais
transmise au PTY. C'est le même mécanisme que O3.

**v2, diffs de cellules OpenTUI par IPC** : l'enfant luciole rend dans un buffer hors
écran et envoie les cellules changées ; l'hôte les copie (`drawFrameBuffer`). Gain
seulement si les diffs sont groupés au rythme des frames : 0,06 à 0,6 fois le flux VT ;
envoyés à chaque lecture PTY de 4 Kio, jusqu'à 8,8 fois le flux VT, et il faut une
commande de défilement. À envisager après la v1, pour les applications luciole seulement
(images kitty de files, fidélité exacte des couleurs) ; les shells restent en VT.

Limites : exécuté sur macOS arm64 seulement ; Linux (`setsid` au lancement détaché)
probable, non vérifié ; pas de PTY Bun sous Windows.

## 5. Mode `sandbox`

macOS, Seatbelt (probe : 38/38 assertions) :

- profil **généré** depuis les capacités, `deny default`, puis le minimum mesuré par
  bissection pour que Bun démarre : `sysctl-read` (sans elle, crash au démarrage),
  lecture de `/`, `/usr/lib`, du cache dyld, du binaire et des bibliothèques Nix, des
  données ICU de `/usr/share/icu` (sans elles, avec le Bun officiel : « failed to
  initialize Segmenter »), liste du répertoire contenant `node_modules` (sans elle : « bun
  is unable to write files: EPERM », trompeur), liens `/etc` et `/var` et données de
  fuseau (sans eux : UTC silencieux). Aucun service mach, rien de `/System`, pas de
  règle JIT ;
- React + le renderer natif OpenTUI démarrent sous le profil ;
- le profil est hérité par les sous-processus (un enfant autorisé ne lit toujours pas
  `~/.ssh`) ; `pbcopy`/`pbpaste`, `security`, `open` échouent même quand leur binaire est
  autorisé : c'est le service système qui est bloqué ;
- surcoût : `bun -e 0` 10 → 19 ms, enfant React + OpenTUI 67 → 73 ms (médianes de 15) ;
- `sandbox-exec` est marqué obsolète mais présent et fonctionnel ;
  `sandbox_init_with_parameters` par `bun:ffi` fonctionne aussi (API privée ; le lanceur
  doit être minimal, ce qu'il a ouvert avant reste utilisable).

Linux : voir l'étape 8 (Avancement) ; le lanceur natif `luciole-sandbox` applique
Landlock et seccomp juste avant l'`exec` de l'enfant (décision 6), avec ses propres espaces
de noms ou sous bubblewrap quand le système les permet.

Les capacités médiées par l'hôte (`clipboard`, `notify`, `open-url`, `secrets`,
`input.global`, `tabs.message`) passent par un canal IPC hôte ↔ enfant : un
file descriptor hérité (socketpair) porteur de messages validés par Zod, pas les
séquences OSC du flux VT (un OSC 52 écrit par une application sandboxée ne doit jamais
atteindre le presse-papiers sans passer par la vérification de capacité).

**Server confiné** (`src/sandbox/server.ts`, `confineServer`) : pour un hôte qui lance un
Server dont il ne se fie pas au code (l'aperçu de studio). Même profil généré, sans
terminal, plus l'écoute d'un seul port loopback choisi par l'hôte ; `net` par hôte via le
proxy de l'hôte. Lecture : son build ; écriture : son répertoire de données (testé dans
`tests/sandbox.test.ts`). macOS seulement : sous
`luciole-sandbox`, le Server écouterait dans son espace de noms réseau et l'hôte le
joindrait par un relais inverse, à construire ; ailleurs le mode est refusé.

## 6. Risques

| Risque                                                                              | Mitigation                                                                                                               |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| ABI trop large : chaque mise à jour de React/OpenTUI casse tous les bundles publiés | ABI minimale, Client générique multi-ABI (plusieurs runtimes en cache), refus explicite                                  |
| `inline` perçu comme sûr                                                            | jamais par défaut pour une URL ; le lanceur affiche « confiance totale, capacités non appliquées » ; audit des built-ins |
| TOFU : première connexion détournée                                                 | empreinte affichée au premier usage, épinglage hors bande (`luciole trust <origine> <fpr>`)                              |
| Rotation de clé impossible                                                          | déclaration de rotation signée par l'ancienne clé (à concevoir)                                                          |
| Seatbelt : `sandbox-exec` obsolète, SBPL non documenté                              | `sandbox_init` via FFI ; profil testé à chaque version de macOS (probe = test)                                           |
| `localhost:<port du proxy>` autorise tout service qui prendrait ce port             | proxy lancé avant l'enfant, port tenu ; sur Linux, socket unix seul                                                      |
| PTY en sandbox : la règle couvre tous les `/dev/ttys*`                              | règle sur le chemin exact du PTY alloué (étape 7) ; `pty` refusée en sandbox macOS                                       |
| Clés d'instance choisies par le Client : une copie du manifeste par clé côté Server | cache borné, ou `Proxy` sans cache ; clé validée par Zod                                                                 |
| Capacités déclarées dans le `package.json` et usage réel divergents                 | le build compare avec l'audit des built-ins ; en `sandbox`, l'OS tranche de toute façon                                  |
| Dépendance au lanceur et au champ `luciole`                                         | étape 5 après le lanceur ; `capabilities` ajouté à son schéma par un diff court                                          |
| Focus global OpenTUI                                                                | l'hôte retire et rend le focus à la bascule                                                                              |
| Fidélité VT (images kitty de files, souris, séquences rares)                        | voir section 4 ; v2 par diffs de cellules OpenTUI                                                                        |

## 7. Plan d'implémentation dans `src/`

Chaque étape est mergeable seule et garde `bun run verify` et les smokes PTY verts.

| Étape | Contenu                                                                                                                                                                                                                           | Fichiers                                                                | Estimation |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------- |
| 1     | Préfixe d'instance : `registerModules`, `x-luciole-instance` (Transport, Server, manifeste préfixé en cache borné), `actionReference` lié au pane, fin de `current` ; tests à deux panes du même build et de deux builds (O1, O2) | `flight/client.ts`, `client.tsx`, `transport.ts`, `server.ts`, `tests/` | 3 j        |
| 2     | Export `<Embed>` : keymap par pane, boundary, focus rendu à la bascule (O3, O4) ; test inline à deux apps (repris du probe)                                                                                                       | `client.tsx` (ou `embed.tsx`), `tests/`                                 | 3 j        |
| 3     | Sortie `.luciole/app/` : bundle sans runtime, audit des built-ins, refus du TLA ; `luciole.capabilities` (schéma Zod partagé, recopié dans le manifeste, comparé à l'audit) ; runtime bundlé ; `src/abi.ts`                       | `build.ts` (ajout localisé), `abi.ts`, `capabilities.ts`                | 3,5 j      |
| 4     | Signature (`luciole keys`, `luciole build --sign-bundle`), routes `/manifest` et `/bundle`                                                                                                                                        | `commands/keys.ts`, `server.ts` (2 routes), `sign.ts`                   | 2 j        |
| 5     | Client générique branché sur le lanceur (étape URL ; paquets installés, npm, git par le même chargeur) : TOFU, cache, stockage par origine, onglets, bascule clavier ; mode `inline` et son avertissement                         | `launcher/*`, `generic/*`, `session.ts`, `connect.ts`                   | 4 j        |
| 6     | Mode `process` : widget VT, PTY, clavier/souris/resize, multiplexeur local (shell, vim, apps luciole)                                                                                                                             | `vt/*`                                                                  | 5–8 j      |
| 7     | Mode `sandbox` macOS : profil généré depuis `luciole.capabilities`, proxy de sortie, IPC des capacités médiées, écran des capacités, flags `--allow-*`                                                                            | `sandbox/*`                                                             | 6–8 j      |
| 8     | Sandbox Linux : lanceur Rust Landlock + seccomp (décision 6), repli bwrap ; CI Linux                                                                                                                                              | `sandbox/linux.ts`, lanceur natif                                       | 5–7 j      |

Total : 31,5–38,5 jours (auparavant 31–38). Détail de l'écart :

- étape 1, +1 j : le préfixe d'instance touche aussi le Transport et le Server ;
- étape 3, +0,5 j : le champ `capabilities` et sa comparaison avec l'audit ;
- étape 5, −1 j : pas de commande ni d'analyse d'arguments, le lanceur les fournit.

Dépendances : l'étape 5 suivait le lanceur (`src/launcher/`, champ `luciole`) ; les
étapes 1 à 4 n'en dépendaient pas. Les étapes 1–2 profitent aussi aux applications
actuelles (tests à plusieurs Applications, boundary).

### Avancement

- **Étape 8 (mode `sandbox` Linux)** : livrée sur `feat/embed-sandbox-linux`
  (`native/luciole-sandbox/`, `src/sandbox/{mechanism,linux,confine,bridge}.ts`). Un lanceur
  natif en Rust, **`luciole-sandbox`**, reçoit une politique JSON structurée (validée par
  Zod côté hôte et par serde, champs inconnus refusés, côté lanceur ; argv exécuté, jamais
  de shell), puis dans l'ordre : espaces de noms, relais, Landlock (appels système directs,
  droits selon l'ABI), seccomp, `execv`. Le mécanisme est choisi au lancement, le plus fort
  d'abord (`--probe` du lanceur) :
  - **`userns`** : le lanceur crée lui-même les espaces de noms utilisateur, montage, IPC,
    réseau (boucle locale seule) et PID (dans un processus intermédiaire : après
    `unshare(CLONE_NEWPID)` le superviseur ne pourrait plus créer les threads de ses
    relais). Le Server et le proxy sont joints par des relais 127.0.0.1:3000/3128 vers des
    sockets Unix de l'hôte. Landlock ABI ≥ 1.
  - **`bwrap`** : le système refuse les espaces de noms au lanceur (Ubuntu ≥ 23.10,
    AppArmor) mais permet bubblewrap : bwrap fait les espaces de noms et ne monte que le
    nécessaire (ce qui confine les fichiers même sans Landlock) ; le lanceur ajoute
    Landlock s'il existe, seccomp et les relais.
  - **`landlock`** (ABI ≥ 6, portée des signaux) : aucun espace de noms. Fichiers,
    exécution et signaux confinés ; **le réseau ne l'est pas par hôte** (Landlock filtre
    TCP par port, vers toute adresse ; UDP refusé par seccomp). Jamais par défaut : une URL
    s'ouvre avec `--sandbox` explicite, un `net` par hôte est refusé, et l'écran le dit
    (« réseau N'EST PAS confiné par hôte »).
  - sinon, le mode est refusé avec la raison (ABI, espaces de noms, bubblewrap).

  **Mode par défaut d'une URL sous Linux** : `sandbox` quand le mécanisme confine le
  réseau (`userns`, `bwrap`) ; sinon refus expliqué, `--sandbox` ou `--inline`.
  Mesures (Linux 7.0, Landlock ABI 8, conteneurs OrbStack arm64) :
  - **Landlock ne restreint pas la connexion à un socket Unix nommé** (écriture refusée,
    `connect` accepté) : sans espace de noms montage, D-Bus, Wayland, X11 resteraient
    joignables. seccomp refuse donc à l'enfant `socket(AF_UNIX)` (et netlink, packet),
    `socketpair` reste permis (le canal IPC est hérité) ; le Server d'un tunnel ssh est
    relayé en TCP. Aussi refusés : `ioctl(TIOCSTI|TIOCLINUX)`, `ptrace`,
    `process_vm_*`, `io_uring_*` (ses opérations échapperaient au filtre), espaces de noms
    et montages (`clone3` répond ENOSYS pour exposer les drapeaux de `clone`), trousseaux
    du noyau, `bpf`, `perf_event_open`, `userfaultfd`, modules, `kexec`.
  - l'`execve` d'un binaire dynamique exige EXECUTE sur son interpréteur ELF
    (`ld-linux-*`) ; le résolveur de Bun liste le répertoire qui contient `node_modules`
    (droit READ_DIR seul, ses fichiers restent fermés) ; `/proc` limité à `/proc/self`
    (après le fork) et à quelques fichiers.
  - **`pty` accordable avec un devpts privé** (`userns` : `devpts newinstance` sur
    `/dev/pts` ; `bwrap` : `--dev`) : l'enfant ouvre ses propres PTY, écrire sur le chemin
    du terminal d'un autre processus échoue (testé). Refusée en `landlock` (même raison
    que Seatbelt : `/dev/pts` entier ouvrirait les terminaux de l'utilisateur).
  - démarrage (`bun -e`, médiane de 15) : nu 1,7–1,9 ms ; `landlock` +0,4 ms ; `userns`
    +1,8 ms ; `bwrap` +4 ms.

  Distribution : binaires statiques musl par architecture (`dist/linux-x64`,
  `dist/linux-arm64`, 520–570 Ko), valables sur glibc et musl, commités avec `SHA256SUMS`
  que l'hôte vérifie avant usage ; `bun scripts/build-sandbox.ts [--check]` les reconstruit
  à l'identique (image Rust épinglée par digest, `Cargo.lock`, dépendances épinglées :
  `libc`, `seccompiler`, `serde`, `serde_json`). L'utilisateur n'installe rien ; le Client
  générique étant luciole lui-même, rien ne change pour `luciole build --compile`.
  Tests : `bun scripts/linux-sandbox.ts` (conteneurs Debian, utilisateur non root, un par
  mécanisme : `tests/sandbox.test.ts`, `test:pty:sandbox`, `cargo test`) ; job CI
  `linux-sandbox` (x64, `--check` compris). Tous verts en arm64. Limites : x64 n'est pas
  testable émulé sur arm64 (Rosetta : ni Landlock ni `open_tree`), il l'est en CI ; bwrap
  dans Docker demande `systempaths=unconfined` (monter un `/proc` neuf), pas un vrai hôte ;
  le chemin AppArmor d'Ubuntu (bwrap autorisé, lanceur refusé) est simulé en forçant le
  mécanisme (`LUCIOLE_SANDBOX_MECHANISM`), pas mesuré sur Ubuntu.

- **Étape 7 (mode `sandbox` macOS)** : livrée sur `feat/embed-sandbox-macos`
  (`src/sandbox/`). **Mode par défaut d'une URL sur macOS** : `luciole <url>` ouvre
  l'origine en `sandbox` ; `--inline` reste un choix explicite et mémorisé, `--sandbox`
  y revient ; ailleurs (Linux jusqu'à l'étape 8), refus sans `--inline` comme avant.
  Avant toute exécution, l'**écran des capacités** donne la route du Server et chaque
  capacité accordée avec qui l'applique (OS, proxy, hôte), plus une ligne « refusée » pour
  ce qui ne peut pas l'être ; les capacités déclarées sont acceptées une fois par origine,
  les drapeaux `--allow-read=…`, `--allow-write=…`, `--allow-net=…`, `--allow-exec[=…]`,
  `--allow-secrets=…`, `--allow-clipboard-read|write`, `--allow-notify`,
  `--allow-open-url`, `--allow-input-global`, `--allow-tabs-message` en ajoutent, le tout
  mémorisé dans `origin.json` (`granted`, `denied`). Mécanismes :
  - **Seatbelt par `sandbox-exec`**, pas `sandbox_init_with_parameters` par `bun:ffi` :
    la même API privée, mais un processus neuf confiné dès sa première instruction, alors
    qu'un Bun qui se sandboxe lui-même garde ce qu'il a ouvert avant et démarre sans
    confinement. Sans `/usr/bin/sandbox-exec`, le mode est refusé, jamais simulé.
  - **Profil généré** (`profile.ts`) : `deny default`, le minimum mesuré par le probe,
    lecture de luciole et de ses `node_modules`, du bundle épinglé, écriture de `sessions/`
    de l'origine et d'un répertoire privé (`TMPDIR`, `HOME`), puis les capacités.
    **PTY : `file-ioctl` sur le chemin exact de l'esclave alloué** (trouvé par numéro de
    périphérique, Bun ne l'expose pas) ; sans elle `setRawMode` échoue (EPERM).
  - **Réseau** : le Server toujours joignable (port loopback, socket du tunnel ssh tenu
    par l'hôte, ou proxy pour un Server distant) ; `net` par hôte via le proxy de l'hôte,
    lancé avant l'enfant et tenu jusqu'à sa fin, qui résout les noms et n'ouvre qu'un
    hôte par connexion (`Connection: close`) ; `net: *` par l'OS.
  - **Capacités médiées** : `host` dans `@luciole-sh/core/client`, un par bundle (lié comme
    `luciole:actions`), et les hooks `useHostMessage`, `useGlobalKey`, `useCapability`.
    L'enfant demande par l'IPC de Bun (socketpair hérité) ; l'hôte valide (Zod), vérifie
    la capacité, demande à l'utilisateur si elle n'est pas décidée (`Ctrl+O y`/`n`, réponse
    mémorisée), puis exécute. Un OSC 52 de l'enfant n'est qu'un octet du flux VT : le
    widget ne le transmet pas (testé).
  - L'enfant est un Client `run()` construit depuis `src/sandbox/child.ts` (redirection
    TanStack du rôle Client) ; il quitte quand son canal IPC se ferme, même si l'hôte est
    tué (`SIGKILL` mesuré).

  Mesures (macOS 26.6.2, Bun 1.4.2) : mdreader sandboxé par URL, de l'ouverture de la
  sandbox au premier texte rendu, 280–330 ms (Server local) ; construction de l'enfant
  ≈ 15 ms à chaud. Écarts : **`pty` est refusée en sandbox sur macOS** : la seule règle
  qui laisse l'enfant utiliser ses propres PTY (`/dev/ttys*`, celle du probe) lui ouvre
  aussi les terminaux des autres sessions de l'utilisateur (mesuré : ouverture en
  lecture-écriture d'un PTY tenu par un autre processus) ; `(allow pseudo-tty)` ne suffit
  pas. Une capacité déclarée `pty` est affichée « refusée », `--allow-pty` est une erreur.
  `host.secret` lit seulement (trousseau `luciole:<origine>`, rempli par l'utilisateur) ;
  `input.global` ne se demande pas à l'exécution (manifeste ou drapeau). Une capacité
  appliquée par l'OS ne change pas pendant l'exécution (profil fixe) ; seules les
  médiées peuvent être accordées en cours de route.

- **Étape 5 (Client générique)** : livrée sur `feat/embed-generic` (`src/generic/`).
  `luciole <url> [<url>…] [--inline] [--yes]` : l'étape URL du lanceur prépare chaque
  origine dans le processus du lanceur, qui a encore le terminal pour ses questions
  (`prepare.ts`) : `GET /manifest`, signature exigée, clé ABI, épinglage TOFU par
  origine (empreinte affichée, question au premier usage ; clé changée → refus avec
  `luciole trust <origine> <empreinte>`), puis `GET /bundle/<sha256>` en cache sous
  `$XDG_CACHE_HOME/luciole/bundles/<sha256>.cjs`. Par origine, sous
  `$XDG_STATE_HOME/luciole/origins/<sha256(origine)>/` : `origin.json` (clé épinglée, mode,
  capacités acceptées), `app/` (manifeste reçu, lien vers le cache), `sessions/`.
  L'origine est l'URL donnée, normalisée (schéma, hôte, port ; chemin pour ssh), jamais
  l'adresse d'un tunnel. Puis l'app hôte `src/generic/browser` (construite et lancée comme
  l'interface du lanceur) ouvre chaque origine dans un onglet `<Embed>` et revérifie la
  signature contre la clé épinglée. **Mode par défaut** (jusqu'à l'étape 7) : le `sandbox`
  n'existant pas, une URL ne s'ouvrait qu'après un choix explicite `--inline` (mémorisé
  par origine) ; sans lui, refus expliqué. L'avertissement « Confiance totale : … » et les capacités déclarées
  (non appliquées) sont affichés avant chaque ouverture. Écarts : le bearer reste en
  mémoire, par Application donc par origine, comme dans `run()` : le framework n'écrit
  jamais de bearer sur disque et l'étape n'a pas changé cette règle ; `--process` n'est
  pas proposé (il donnerait les mêmes droits qu'`inline`, avec un enfant de plus).

- **Étape 4 (signature, routes, O6)** : livrée sur `feat/embed-sign`. Clé d'éditeur
  Ed25519 (`src/publisher.ts`) : `luciole keys [generate]` (empreinte `SHA256:…` comme
  ssh), fichier `$XDG_CONFIG_HOME/luciole/keys/publisher.pem` (ou `LUCIOLE_PUBLISHER_KEY`),
  0600 dans un répertoire 0700, refusée si d'autres peuvent la lire, jamais remplacée
  par `generate`. `luciole build --sign-bundle` (implique `--app-bundle`) signe un encodage
  canonique : préfixe de domaine puis tableau ordonné des champs, `capabilities` à clés
  triées, clé publique comprise. Le Server sert `GET /manifest` (texte écrit par le
  build, `no-cache`) et `GET /bundle/<sha256>` (`immutable`) avant la session et le
  contrôle de build ; sans bundle, 404. `loadAppBundle` vérifie toute signature présente
  et offre `publisher: { required, trust }`, où l'étape 5 branchera l'épinglage par
  origine. Écart : `/bundle` porte le hash dans son chemin (une URL = un contenu, d'où
  `immutable`).

- **Étape 3 (bundle d'application, ABI, capacités, O5)** : livrée sur `feat/embed-bundle`.
  `luciole build` produit `.luciole/app/` (troisième rôle du build, traité comme le Client
  pour les frontières : `index.cjs` `bun-cjs` + `manifest.json` non signé). `src/abi.ts` :
  11 spécifiers, `ABI_VERSION` 1, versions épinglées (un test les compare à
  `package.json`), clé `1-<sha256 court>`. Audit des built-ins par le metafile ;
  top-level await : pas de `.luciole/app/`, avertissement avec fichier et ligne, le Client
  et le Server construits comme avant (échec seulement avec `--app-bundle`) ;
  `luciole.capabilities` (schéma de
  `src/capabilities.ts`, repris du probe sandbox, ajouté à `AppField` du registre)
  recopié dans le manifeste et comparé à l'audit (avertissement). `openApplication({
bundle, url })` évalue ce bundle contre le runtime de l'hôte (`src/app-bundle.ts`) :
  plus de copie du runtime par pane, `app.view` et les contextes sont ceux de l'hôte.
  Écarts : `zod` classique n'est pas dans l'ABI (le runtime Client ne le contient pas,
  une application qui l'utilise l'embarque) ; l'option `client` d'`openApplication`
  devient `bundle` ; une application qui ne déclare rien ne reçoit pas d'avertissement.

- **Étape 2 (`<Embed>`, O3, O4)** : livrée sur `feat/embed-pane` (`src/embed.tsx`).
  `<Embed app name active prefix? />` (copie du runtime de l'hôte) garde le cadre, la
  boundary par pane, le focus mis de côté quand le pane est inactif (et celui qu'il prend
  pendant ce temps), et filtre les touches ; il rend `app.view`, la vue de la copie du
  runtime du pane (keymap, routeur, contexte `useApplication` de cette copie : chaque
  Client construit embarque la sienne). `openApplication({ client, url, instance? })`
  évalue le bundle une fois par pane, choisit la clé d'instance, ouvre la connexion.
  `Application.dispose()`, `disposed`, `onDispose()`. Écarts : `prefix` s'ajoute à
  `<Embed>` comme à `<Terminal>` (une seule touche pour les deux, pas de contexte
  partagé) ; `app.quit` d'un pane est laissé à l'hôte (`Ctrl+C` ne quitte jamais l'hôte
  depuis un pane). `examples/mux` montre mdreader à côté d'un shell (`MUX_APPS`).

- **Étape 1 (préfixe d'instance, O1, O2)** : livrée sur `feat/embed-instance`.
  `ApplicationOptions.instance` (clé `[a-z0-9-]{1,32}`, `src/instance.ts`) envoyée en
  `x-luciole-instance` ; le Server passe à Flight une copie du manifeste préfixée par clé
  (cache borné à 64 copies, analyse paresseuse), dans le flux imbriqué de la page comme
  dans l'enveloppe ; `registerModules(key, resolver)` remplace `installResolver`, dans un
  registre partagé par toutes les copies du runtime (`globalThis`). `let current` est
  supprimé : le build émet par bundle un module `luciole:actions` (`createActions()` de
  `@luciole-sh/core/client`) que les stubs `"use server"` importent et que `createApp` lie à
  l'Application qu'il crée. Écart : cette liaison par bundle touche `src/build.ts`
  (≈ 15 lignes) ; elle sert telle quelle aux bundles du Client générique (étape 3), sans
  table `require` à surcharger. Deux panes d'un même build = deux évaluations du bundle.

- **Étape 6 (mode `process`)** : livrée sur `feat/embed-process`, avant l'étape 1 (use-cache
  et distribution modifiaient alors `server.ts`, `transport.ts` et `client.tsx`).
  `<Terminal>` dans `@luciole-sh/core/client` (`src/vt/`), exemple `examples/mux`, smoke
  `test:pty:mux`. Écarts : la touche préfixe est une prop du terminal (le keymap passe
  avant le renderable focalisé, le terminal doit savoir laquelle laisser) ; `run()` ne
  quitte plus sur un `Ctrl+C` déjà traité (sinon `Ctrl+C` dans un shell quitterait le
  multiplexeur). OSC 8 reste non rendu ; Linux non vérifié ; pas de Windows.

### Limites connues

- Un binaire compilé (`luciole build --compile`) n'embarque pas `.luciole/app/` : son
  Server répond 404 à `/manifest` et `/bundle/…`, il ne peut pas être ouvert par URL.
- L'épinglage est par origine : un Server qui change de port ou d'hôte est une nouvelle
  origine (nouvelle question, nouvelle clé épinglée).

## 8. Décisions

Tranchées le 24 septembre 2026 sur les questions ouvertes de la première version de ce
document.

1. **Pane embarquable** : un nouvel export `<Embed>`, pas de nouvelles props sur `Shell`
   (O3, étape 2).
2. **Point d'entrée** : pas de nouvelle commande ; `luciole https://…` passe par le lanceur
   (chemin → installé → npm → git → URL), sur lequel se branche le
   Client générique (section 2, étape 5).
3. **Capacités** : déclarées statiquement dans `luciole.capabilities` du `package.json`,
   lisibles avant toute exécution ; le build les recopie dans le manifeste signé
   (section 1, étapes 3 et 7).
4. **Deux origines ou deux instances du même build** : préfixe par instance dès
   maintenant (O1 ; probe `panes/instance`, étape 1).
5. **Accès Node sensibles en `inline`** : autorisés ; `inline` = confiance totale,
   capacités non appliquées, et le lanceur l'affiche explicitement (section 1, étape 5).

6. **Sandbox Linux** : un **lanceur natif en Rust** (`luciole-sandbox`, livré compilé avec
   luciole) applique lui-même Landlock et seccomp (TIOCSTI, `ptrace`, sockets Unix…), puis
   `exec` l'enfant ; pas de `landrun`. Le mécanisme est choisi au lancement, le plus fort
   d'abord (étape 8) : `userns` (espaces de noms créés par le lanceur), sinon `bwrap`
   (quand AppArmor les refuse au lanceur, Ubuntu ≥ 23.10), sinon `landlock` seul, qui ne
   confine pas le réseau par hôte et ne s'applique jamais par défaut. Sans aucun des
   trois, le mode `sandbox` est **refusé** avec un message clair, jamais simulé.
