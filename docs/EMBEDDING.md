# Client générique et applications embarquées

Statut : **recherche**, branche `research/embedding`. Rien n'est livré dans `src/` ; tout ce
qui suit s'appuie sur quatre probes exécutés le 24 septembre 2026 (macOS 26.6.2 arm64,
Bun 1.4.2) : [inline](../probes/inline/README.md),
[generic-client](../probes/generic-client/README.md),
[vt-embed](../probes/vt-embed/README.md), [sandbox](../probes/sandbox/README.md).

Objectif : un Client airtty capable d'ouvrir plusieurs applications à la fois, comme un
navigateur à onglets ou un multiplexeur local (tmux, herdr) : applications airtty
téléchargées depuis leur Server, applications installées, shells, vim.

## 1. Modèle

### L'origine

Une **origine** est ce qui reçoit des droits : l'URL d'un Server (schéma, hôte, port,
telle que l'utilisateur l'a donnée, pas l'adresse locale d'un tunnel), un paquet installé
(chemin + clé de l'éditeur) ou une commande locale (`$SHELL`, `vim`). Les droits, la clé
épinglée, le stockage et les jetons sont rangés par origine.

### Trois modes d'isolation, un curseur par origine

| Mode      | Où tourne l'application                                        | Isolation                     | Rendu                        | Pour                                          |
| --------- | -------------------------------------------------------------- | ----------------------------- | ---------------------------- | --------------------------------------------- |
| `inline`  | dans le processus du Client, même arbre React                  | aucune                        | direct, focus/thème partagés | code de confiance : local, installé, signé    |
| `process` | processus enfant, sans sandbox                                 | crashs uniquement             | widget VT (PTY + émulateur)  | multiplexeur local : shells, vim, apps airtty |
| `sandbox` | processus enfant sous sandbox OS (Seatbelt ; bwrap + Landlock) | crashs + capacités appliquées | widget VT                    | URL distante, paquet non signé                |

Défauts : local ou installé → `process` ; URL distante ou paquet non signé → `sandbox`.
L'utilisateur surcharge (réglage mémorisé par origine, ou flag CLI) ; l'application
jamais. `inline` est un choix explicite de l'utilisateur pour une origine de confiance.
`process` n'ajoute **aucune** couche de sécurité : c'est tmux, pas un navigateur.

### Capacités

À la Deno : `fs.read`/`fs.write` par chemin, `net` par hôte, `exec` (par binaire) et
`pty`, `clipboard.read`/`clipboard.write`, `notify`, `open-url`, `secrets`,
`input.global`, `tabs.message`. Déclarées dans le manifeste de l'application, accordées
par l'utilisateur ou par flag (`--allow-net=api.example.com`), mémorisées par origine.

Règle d'affichage, vérifiée par le probe sandbox : **une capacité n'est montrée que si
quelqu'un l'applique**. En `inline` et `process`, l'écran d'origine dit « aucune
isolation » et n'offre aucun interrupteur par capacité. En `sandbox`, chaque capacité
accordée a une ligne qui dit qui l'applique (OS, proxy, hôte). Tout accorder équivaut à
passer en `process` : le Client le propose au lieu de simuler une sandbox vide.

Qui applique quoi (mesuré, voir probes/sandbox) :

| Capacité                                         | macOS                                                     | Linux                                                   |
| ------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------- |
| `fs.read`, `fs.write`                            | OS (Seatbelt, par chemin)                                 | OS (montages bwrap ; Landlock en plus)                  |
| `net` par hôte                                   | proxy de l'hôte ; l'OS limite l'enfant au port du proxy   | proxy via socket unix ; `--unshare-net` bloque le reste |
| `net: *`                                         | OS                                                        | OS                                                      |
| `exec` (par binaire, hérité par les descendants) | OS                                                        | OS avec Landlock ; sans Landlock, non applicable        |
| `pty`                                            | OS (`/dev/ptmx`)                                          | OS (`--dev`)                                            |
| `clipboard.*`, `notify`, `open-url`, `secrets`   | hôte : la voie directe (mach-lookup) est bloquée par l'OS | hôte : aucun socket système monté                       |
| `input.global`, `tabs.message`                   | hôte (IPC)                                                | hôte (IPC)                                              |

Seatbelt ne connaît que `*` et `localhost` comme hôte distant : un nom ou une IP dans le
profil est une erreur de compilation du profil (vérifié). Le filtrage par hôte passe donc
toujours par un proxy de sortie tenu par l'hôte ; l'enfant ne résout même pas le DNS.

## 2. Client générique : runtime et bundle d'application

Aujourd'hui chaque application distribue son propre Client : `.airtty/client/index.js`
embarque le runtime airtty, TanStack Router et le keymap ; seuls React, OpenTUI et Flight
sont external (`src/build.ts:441`). Un Client générique inverse la relation.

- **Runtime** : React, OpenTUI, keymap, TanStack Router, Zod, le runtime airtty. Compilé
  dans le binaire du Client générique. Il doit lui-même être un artefact de build : la
  redirection `@tanstack/router-core/isServer` → `client.js` de `src/build.ts` s'y
  applique (probe : 292 Ko, 68 Ko gzip, sans React/OpenTUI).
- **Bundle d'application** : les Client Components, le route tree généré, les stubs
  `"use server"`, les dépendances propres à l'application. Tout le reste est un
  `require` résolu par l'hôte (probe : mdreader 20 Ko, 7,5 Ko gzip ; files 29 Ko).
- **ABI de runtime** : la liste fermée des spécifiers que le bundle peut importer
  (`airtty/client`, `airtty/route-tree`, `@tanstack/react-router`, `react`,
  `react/jsx-runtime`, `@opentui/core`, `@opentui/react`, `@opentui/react/jsx-runtime`,
  `@opentui/keymap`, `@opentui/keymap/react`, `zod`, `zod/mini`), une version entière
  incrémentée à la main quand un export d'`airtty/client` change de façon incompatible, et
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
   buildId dans `x-airtty-build`, que le Server vérifie déjà).

Probe : altération d'un octet, manifeste modifié après signature, clé changée, ABI
différente, `require` hors ABI : tous refusés avant évaluation. Démarrage à chaud
(manifeste + vérification + cache) < 1,3 ms en loopback ; à froid jusqu'à la première
frame complète de mdreader ≈ 200 ms, dont l'essentiel est le rendu Server.

### Stockage partitionné

Tout ce que le Client écrit est rangé sous l'origine : sessions (`src/session.ts` range
aujourd'hui par nom d'application : `$XDG_STATE_HOME/airtty/<app>/sessions`), bearer,
configuration (`src/connect.ts` : `~/.config/airtty/<app>.json`), cache des bundles
(partagé par hash, sans risque), clés épinglées, capacités accordées. Proposition :
`$XDG_STATE_HOME/airtty/origins/<sha256(origine)>/` et le cache sous
`$XDG_CACHE_HOME/airtty/bundles/<sha256>.js`.

## 3. Obstacles dans `src/` et refactors proposés

Le probe inline monte `examples/mdreader` et `examples/files` côte à côte dans un seul
processus et mesure chaque obstacle, puis le même scénario avec les refactors appliqués
depuis l'extérieur de `src/` (`probes/generic-client/host.tsx`) : tout passe.

### O1. Un seul résolveur de modules par processus

`src/flight/client.ts:12-27` installe **un** `__webpack_require__` global dont la fonction
`resolve` est remplacée par chaque `installResolver`, appelé par chaque `new Application`
(`src/client.tsx:192`). Mesuré : la seconde application montée gagne ; la page de la
première affiche « Unknown module …/components/Reader.tsx ».

Deux faits contraignent la solution :

- le codec Flight navigateur (`client.browser`) crée ses réponses avec une table de
  modules `null` : impossible de lui passer une table par réponse ; `client.edge` et
  `client.node` acceptent une table mais n'ont pas de `callServer` ;
- la résolution est **paresseuse** : `requireModule` s'exécute pendant le rendu React
  (`React.lazy`), longtemps après le décodage. Aucun « résolveur de la réponse courante »
  n'est fiable.

L'id doit donc porter l'origine. Il la porte déjà : `src/build.ts:408` préfixe chaque id
de Client Reference et de Server Function par le buildId (24 hex).

**Refactor** (`src/flight/client.ts`, ≈ 30 lignes) : un registre `prefix → resolver` ;
`installResolver(next)` devient `registerModules(buildId, resolver): () => void`, et le
global aiguille sur le préfixe. Le Client d'aujourd'hui (une application) ne change pas
de comportement. Le build ne change pas.

Cas limite : deux origines qui servent **le même build** (staging et production)
partagent le préfixe. v1 : l'hôte refuse de monter la seconde en `inline` et la propose
en `process`. Si le besoin se confirme, un préfixe d'instance (« royaume ») envoyé par le
Client (`x-airtty-realm`) et ajouté par le Server aux ids du manifeste qu'il passe à
`renderToReadableStream` (un `Proxy` par requête dans `src/server.ts`).

### O2. `let current: Application`

`src/client.tsx:133-139` et `:245` : les stubs générés pour les modules `"use server"`
importés par un Client Component (`src/build.ts:537-543`) appellent
`actionReference(id)`, qui passe par `current`, la dernière Application construite.
Les références reçues **par Flight** (Server Function passée en prop par une page) ne
sont pas concernées : elles utilisent le `callServer` de leur réponse. Mesuré :
`useLive(watchLibrary)` de mdreader part vers le Server de files.

**Refactor** (`src/client.tsx`, ≈ 20 lignes) : le même registre par préfixe associe le
buildId à son Application ; `actionReference` aiguille sur le préfixe de l'id d'action.
`current` disparaît. Pour le Client générique, chaque évaluation de bundle reçoit de
toute façon son propre `airtty/client` (table `require`) : l'hôte peut aussi y lier
`actionReference` à l'Application de l'origine, ce que fait le probe.

Une **Application par origine**, chacune avec son Transport (déjà par instance), son
routeur en memory history (déjà), son `Restoration`, son bearer (déjà), ses listeners.
Le reste de l'état « par processus » vit dans `run()` (`src/client.tsx:782-849` : signaux,
session, supervision `airtty dev`) : il reste au niveau du Client hôte, pas des embeds.

### O3. Clavier et focus

`Shell` (`src/client.tsx:732-742`) crée un keymap sur le renderer entier. Mesuré avec
deux `Shell` : le dernier créé passe en premier (`prependListener`) et consomme les
touches qu'il lie (`Ctrl+R` ne rafraîchit que files) ; les touches qu'il ne lie pas
tombent dans l'autre application (`[` navigue dans mdreader alors que l'utilisateur est
dans files).

**Refactor** : un keymap par embed, construit sur un `KeymapHost` qui n'écoute que si
l'embed a les touches (probe : 40 lignes, `scopedHost`). Les couches `focus` et
`focus-within` des applications fonctionnent sans changement. La bascule entre embeds
appartient à l'hôte (touche préfixe à la tmux, réservée avant tout keymap d'application).

Reste à faire : le focus OpenTUI est global au renderer. Un `<input focused>` d'un embed
inactif recevrait encore la frappe (le renderer route la touche au renderable focalisé,
hors keymap). L'hôte doit mémoriser et retirer le focus à la bascule, et le rendre au
retour.

API publique touchée : `Shell` gagne une variante embarquable (voir questions ouvertes).

### O4. Une erreur de rendu efface tout

`createRoot` d'OpenTUI pose une error boundary à la racine : un rendu qui jette dans une
application remplace l'écran entier (mesuré). **Refactor** : une boundary par embed dans
le Shell embarquable ; l'erreur n'atteint jamais la racine.

### O5. Le build n'a qu'une sortie Client

`src/build.ts:440-448` génère un Client complet. **Refactor** : une seconde sortie
`.airtty/app/` (bundle `bun-cjs` sans runtime + `manifest.json` signé), produite par la
même passe (les graphes, les ids et les stubs sont déjà calculés) ; la validation des
frontières est inchangée. Le probe la reconstruit en 130 lignes hors de `src/` en
relisant `.airtty/manifest.json`.

### O6. Le Server ne sert pas de bundle

Deux routes `GET` dans `serve()` (`src/server.ts`), sans session ni `x-airtty-build`
(elles servent justement à l'obtenir) : `/manifest` (JSON signé) et `/bundle` (octets,
`cache-control: immutable` car adressés par hash). Le probe les sert par un relais devant
le Server ; les flux render/action/live traversent le relais sans tampon.

## 4. Modes `process` et `sandbox` : widget VT

Un enfant `process` ou `sandbox` est un programme terminal ordinaire (shell, vim, ou un
Client airtty lancé par `run()`, sans modification) ; l'hôte l'affiche dans un widget VT.
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

Trous d'OpenTUI 0.5.12, à remonter en amont, comblés dans `probes/vt-embed/gaps.ts` :
sans protocole clavier kitty, F1–F12, `Alt+x` et Backspace n'envoient rien ; DA1, DA2 et
OSC 10/11 restent sans réponse ; OSC 8 (hyperliens) n'apparaît pas dans le rendu (non
comblé).

Conséquence pour l'hôte : les raccourcis globaux passent avant le terminal focalisé. Le
keymap d'une application (ou de l'hôte) volerait les touches du terminal embarqué ; seule
la touche préfixe de l'hôte (`Ctrl+O` dans le probe) doit être réservée, jamais
transmise au PTY. C'est le même mécanisme que O3.

**v2, diffs de cellules OpenTUI par IPC** : l'enfant airtty rend dans un buffer hors
écran et envoie les cellules changées ; l'hôte les copie (`drawFrameBuffer`). Gain
seulement si les diffs sont groupés au rythme des frames : 0,06 à 0,6 fois le flux VT ;
envoyés à chaque lecture PTY de 4 Kio, jusqu'à 8,8 fois le flux VT, et il faut une
commande de défilement. À envisager après la v1, pour les applications airtty seulement
(images kitty de files, fidélité exacte des couleurs) ; les shells restent en VT.

Limites : exécuté sur macOS arm64 seulement ; Linux (`setsid` au lancement détaché)
probable, non vérifié ; pas de PTY Bun sous Windows.

## 5. Mode `sandbox`

macOS, Seatbelt (probe : 38/38 assertions) :

- profil **généré** depuis les capacités, `deny default`, puis le minimum mesuré par
  bissection pour que Bun démarre : `sysctl-read` (sans elle, crash au démarrage),
  lecture de `/`, `/usr/lib`, du cache dyld, du binaire et des bibliothèques Nix, liste du
  répertoire contenant `node_modules` (sans elle : « bun is unable to write files:
  EPERM », trompeur), liens `/etc` et `/var` et données de fuseau (sans eux : UTC
  silencieux). Aucun service mach, rien de `/System`, pas de règle JIT ;
- React + le renderer natif OpenTUI démarrent sous le profil ;
- le profil est hérité par les sous-processus (un enfant autorisé ne lit toujours pas
  `~/.ssh`) ; `pbcopy`/`pbpaste`, `security`, `open` échouent même quand leur binaire est
  autorisé : c'est le service système qui est bloqué ;
- surcoût : `bun -e 0` 10 → 19 ms, enfant React + OpenTUI 67 → 73 ms (médianes de 15) ;
- `sandbox-exec` est marqué obsolète mais présent et fonctionnel ;
  `sandbox_init_with_parameters` par `bun:ffi` fonctionne aussi (API privée ; le lanceur
  doit être minimal, ce qu'il a ouvert avant reste utilisable).

Linux (conteneur privilégié, bwrap 0.12, Landlock ABI 8) : bubblewrap exécuté
réellement (montages, `--unshare-net` + relais vers le socket unix du proxy, PTY via
`--dev`) ; Landlock et seccomp (TIOCSTI, ptrace…) générés, **pas encore appliqués** : il
faut un petit lanceur natif ou `bwrap --seccomp` + `landrun`.

Les capacités médiées par l'hôte (`clipboard`, `notify`, `open-url`, `secrets`,
`input.global`, `tabs.message`) passent par un canal IPC hôte ↔ enfant : un
file descriptor hérité (socketpair) porteur de messages validés par Zod, pas les
séquences OSC du flux VT (un OSC 52 écrit par une application sandboxée ne doit jamais
atteindre le presse-papiers sans passer par la vérification de capacité).

## 6. Risques

| Risque                                                                              | Mitigation                                                                                  |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| ABI trop large : chaque mise à jour de React/OpenTUI casse tous les bundles publiés | ABI minimale, Client générique multi-ABI (plusieurs runtimes en cache), refus explicite     |
| `inline` perçu comme sûr                                                            | jamais par défaut pour une URL ; écran d'origine « aucune isolation » ; audit des built-ins |
| TOFU : première connexion détournée                                                 | empreinte affichée au premier usage, épinglage hors bande (`airtty trust <origine> <fpr>`)  |
| Rotation de clé impossible                                                          | déclaration de rotation signée par l'ancienne clé (à concevoir)                             |
| Seatbelt : `sandbox-exec` obsolète, SBPL non documenté                              | `sandbox_init` via FFI ; profil testé à chaque version de macOS (probe = test)              |
| `localhost:<port du proxy>` autorise tout service qui prendrait ce port             | proxy lancé avant l'enfant, port tenu ; sur Linux, socket unix seul                         |
| PTY en sandbox : la règle couvre tous les `/dev/ttys*`                              | règle sur le chemin exact du PTY alloué                                                     |
| Deux origines servant le même build                                                 | refus en `inline` (v1), préfixe de royaume ensuite                                          |
| Focus global OpenTUI                                                                | l'hôte retire et rend le focus à la bascule                                                 |
| Fidélité VT (images kitty de files, souris, séquences rares)                        | voir section 4 ; v2 par diffs de cellules OpenTUI                                           |

## 7. Plan d'implémentation dans `src/`

Chaque étape est mergeable seule et garde `bun run verify` et les smokes PTY verts.

| Étape | Contenu                                                                                                                             | Fichiers                                                    | Estimation |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------- |
| 1     | Registre par préfixe : `registerModules`, `actionReference` aiguillé, suppression de `current` ; tests à deux Applications (O1, O2) | `flight/client.ts`, `client.tsx`, `tests/`                  | 2 j        |
| 2     | Shell embarquable : keymap par embed, boundary, focus rendu à la bascule (O3, O4) ; test inline à deux apps (repris du probe)       | `client.tsx` (ou `embed.tsx`), `tests/`                     | 3 j        |
| 3     | Sortie `.airtty/app/` : bundle sans runtime, audit des built-ins, refus du TLA, manifeste ; runtime bundlé ; `src/abi.ts`           | `build.ts` (ajout localisé), `abi.ts`                       | 3 j        |
| 4     | Signature (`airtty keys`, `airtty build --sign-bundle`), routes `/manifest` et `/bundle`                                            | `commands/keys.ts`, `server.ts` (2 routes), `sign.ts`       | 2 j        |
| 5     | Client générique `airtty open <url>` : chargeur, TOFU, cache, stockage par origine, onglets, bascule clavier ; mode `inline`        | `commands/open.ts`, `generic/*`, `session.ts`, `connect.ts` | 5 j        |
| 6     | Mode `process` : widget VT, PTY, clavier/souris/resize, multiplexeur local (shell, vim, apps airtty)                                | `vt/*`                                                      | 5–8 j      |
| 7     | Mode `sandbox` macOS : profil généré, proxy de sortie, IPC des capacités médiées, écran des capacités, flags `--allow-*`            | `sandbox/*`                                                 | 6–8 j      |
| 8     | Sandbox Linux : bwrap + lanceur Landlock/seccomp, relais proxy ; CI Linux                                                           | `sandbox/linux.ts`, lanceur natif                           | 5–7 j      |

Total : 31–38 jours. Les étapes 1–2 profitent aussi aux applications actuelles (tests à
plusieurs Applications, boundary) et ne dépendent pas des décisions ouvertes ci-dessous
sauf pour le nom du Shell embarquable.

## 8. Questions ouvertes (API publique)

À trancher avant l'étape correspondante ; le probe a pris un parti sans l'imposer.

1. **Shell embarquable** (étape 2) : `Shell` gagne-t-il des props (`active`, `name`), ou un
   nouvel export (`EmbedShell`, `airtty/embed`) ? Le probe utilise un composant séparé.
2. **Nom et forme de la commande** (étape 5) : `airtty open <url>` ou un binaire distinct
   (`airtty-browser`) ? Le Client générique change-t-il le nom de session (`name`) ?
3. **Déclaration des capacités** (étapes 3, 7) : dans `airtty.json` de l'application (déjà
   lu par le build pour `serverPackages`) ou dans un export du layout racine ?
4. **Même build, deux origines** : refus en `inline` (v1 proposé) ou royaumes tout de
   suite ?
5. **Bundle `inline` et built-ins** : un bundle qui déclare `child_process` peut-il
   seulement être `inline` si l'utilisateur l'accepte explicitement, ou est-il forcé en
   `process`/`sandbox` ?
