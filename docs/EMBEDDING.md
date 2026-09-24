# Client générique et applications embarquées

Statut : **recherche**, branche `research/embedding`. Rien n'est livré dans `src/` ; tout ce
qui suit s'appuie sur quatre probes exécutés le 24 septembre 2026 (macOS 26.6.2 arm64,
Bun 1.4.2) : [inline](../probes/inline/README.md),
[generic-client](../probes/generic-client/README.md),
[vt-embed](../probes/vt-embed/README.md), [sandbox](../probes/sandbox/README.md).

Objectif : un Client airtty capable d'ouvrir plusieurs applications à la fois, comme un
navigateur à onglets ou un multiplexeur local (tmux, herdr) : applications airtty
téléchargées depuis leur Server, applications installées, shells, vim.

Les décisions prises sur la conception sont regroupées en [section 8](#8-décisions) ;
le reste du document en tient compte.

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
`input.global`, `tabs.message`. Déclarées **statiquement** dans le champ
`airtty.capabilities` du `package.json` de l'application (décision 3), lisible avant
toute exécution ; feat/distribution définit déjà le champ `airtty` (`name`, `buildId`,
`binaries`), `capabilities` s'y ajoute avec le schéma Zod du probe sandbox
(`probes/sandbox/capabilities.ts`). Le build recopie ce champ dans le manifeste signé
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

Point d'entrée (décision 2) : pas de nouvelle commande. `airtty https://…` passe par le
lanceur de feat/distribution, qui résout son argument dans l'ordre chemin → installé →
npm → git → URL. Le Client générique se branche sur la dernière étape (URL :
`GET /manifest`, puis ce qui suit) ; les étapes installé, npm et git fournissent un
paquet dont le `package.json` porte déjà `airtty` (`name`, `buildId`, `binaries`,
`capabilities`), et le même chargeur évalue son bundle sans téléchargement.

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

L'id doit donc porter le pane qui le résout. Le buildId que `src/build.ts:408` met déjà
en tête de chaque id ne suffit pas : deux panes de la même application (le cas du
multiplexeur, ou deux origines servant le même build) partagent alors une entrée. Mesuré
(`panes/build`) : les Client References du premier pane sont résolues avec l'instance de
modules du second, et ses Server Functions importées partent par l'Application du
second.

**Décision 4 : préfixe par instance, dès maintenant.** Chaque pane reçoit une clé
d'instance (`p1`, `p2`…, `[a-z0-9-]{1,32}`), que son Transport envoie dans
`x-airtty-instance` à chaque requête. Le Server écrit les Client References de la réponse
`<clé>@<buildId>/<chemin>` : Flight lit `manifest[id].id` pour chaque référence, il suffit
de lui passer une copie du manifeste préfixée par la clé. Sans en-tête, les ids restent
ceux d'aujourd'hui : le Client actuel ne change pas. Les ids de Server Functions ne
changent pas (le Server les connaît ainsi). Mesuré (`panes/instance`, Server patché par
`probes/inline/instance-server.ts`, sans toucher `src/`) : deux panes de mdreader contre
deux Servers affichent chacun son document, résolvent avec leurs propres modules et
envoient leurs actions par leur propre Application.

**Refactor** :

- `src/flight/client.ts` (≈ 30 lignes) : un registre `clé → resolver` ;
  `installResolver(next)` devient `registerModules(key, resolver): () => void`, le global
  aiguille sur le préfixe `<clé>@`, et sans préfixe sur l'unique résolveur enregistré (le
  Client actuel).
- `src/transport.ts` (≈ 3 lignes) : l'en-tête `x-airtty-instance` quand
  `HttpTransportOptions.instance` est défini ; `ApplicationOptions.instance` le transmet.
  Réglé par l'hôte (`<Embed>`, Client générique), jamais par l'application.
- `src/server.ts` (≈ 15 lignes) : l'en-tête validé par Zod, une copie préfixée du
  manifeste par clé passée à `renderToReadableStream`. La clé est choisie par le Client :
  les copies sont gardées dans un cache borné (ou calculées par un `Proxy` sans cache),
  jamais sans limite.
- Le build ne change pas.

### O2. `let current: Application`

`src/client.tsx:133-139` et `:245` : les stubs générés pour les modules `"use server"`
importés par un Client Component (`src/build.ts:537-543`) appellent
`actionReference(id)`, qui passe par `current`, la dernière Application construite.
Les références reçues **par Flight** (Server Function passée en prop par une page) ne
sont pas concernées : elles utilisent le `callServer` de leur réponse. Mesuré :
`useLive(watchLibrary)` de mdreader part vers le Server de files.

**Refactor** (`src/client.tsx`, ≈ 20 lignes) : les ids d'action ne portent pas la clé
d'instance, l'aiguillage par préfixe est donc exclu ici. Chaque pane évalue son bundle
avec sa propre table `require` : son `airtty/client` a un `actionReference` lié à
l'Application du pane (c'est ce que fait le probe). `current` disparaît au profit de
cette liaison ; le Client actuel, un seul pane, lie l'unique Application, et ne change
pas de comportement.

Une **Application par pane**, chacune avec son Transport (déjà par instance), son
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

API publique (décision 1) : un nouvel export `<Embed>` dans `airtty/client`, `Shell`
reste inchangé. Forme proposée, celle du probe (`EmbedShell`) :
`<Embed app={Application} name={string} active={boolean} />`, qui porte le keymap du
pane, sa boundary et le rendu du focus à la bascule.

### O4. Une erreur de rendu efface tout

`createRoot` d'OpenTUI pose une error boundary à la racine : un rendu qui jette dans une
application remplace l'écran entier (mesuré). **Refactor** : une boundary par embed dans
`<Embed>` ; l'erreur n'atteint jamais la racine.

### O5. Le build n'a qu'une sortie Client

`src/build.ts:440-448` génère un Client complet. **Refactor** : une seconde sortie
`.airtty/app/` (bundle `bun-cjs` sans runtime + `manifest.json` signé, qui recopie
`airtty.capabilities` du `package.json`), produite par la même passe (les graphes, les
ids et les stubs sont déjà calculés) ; la validation des frontières est inchangée. Le probe la reconstruit en 130 lignes hors de `src/` en
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
faut les poser dans le processus juste avant l'`exec` de l'enfant, ce que Bun ne permet
pas : c'est le rôle du lanceur Rust retenu (décision 6).

Les capacités médiées par l'hôte (`clipboard`, `notify`, `open-url`, `secrets`,
`input.global`, `tabs.message`) passent par un canal IPC hôte ↔ enfant : un
file descriptor hérité (socketpair) porteur de messages validés par Zod, pas les
séquences OSC du flux VT (un OSC 52 écrit par une application sandboxée ne doit jamais
atteindre le presse-papiers sans passer par la vérification de capacité).

## 6. Risques

| Risque                                                                              | Mitigation                                                                                                               |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| ABI trop large : chaque mise à jour de React/OpenTUI casse tous les bundles publiés | ABI minimale, Client générique multi-ABI (plusieurs runtimes en cache), refus explicite                                  |
| `inline` perçu comme sûr                                                            | jamais par défaut pour une URL ; le lanceur affiche « confiance totale, capacités non appliquées » ; audit des built-ins |
| TOFU : première connexion détournée                                                 | empreinte affichée au premier usage, épinglage hors bande (`airtty trust <origine> <fpr>`)                               |
| Rotation de clé impossible                                                          | déclaration de rotation signée par l'ancienne clé (à concevoir)                                                          |
| Seatbelt : `sandbox-exec` obsolète, SBPL non documenté                              | `sandbox_init` via FFI ; profil testé à chaque version de macOS (probe = test)                                           |
| `localhost:<port du proxy>` autorise tout service qui prendrait ce port             | proxy lancé avant l'enfant, port tenu ; sur Linux, socket unix seul                                                      |
| PTY en sandbox : la règle couvre tous les `/dev/ttys*`                              | règle sur le chemin exact du PTY alloué                                                                                  |
| Clés d'instance choisies par le Client : une copie du manifeste par clé côté Server | cache borné, ou `Proxy` sans cache ; clé validée par Zod                                                                 |
| Capacités déclarées dans le `package.json` et usage réel divergents                 | le build compare avec l'audit des built-ins ; en `sandbox`, l'OS tranche de toute façon                                  |
| Dépendance au lanceur et au champ `airtty` de feat/distribution                     | étape 5 après leur merge ; `capabilities` ajouté à leur schéma par un diff court                                         |
| Focus global OpenTUI                                                                | l'hôte retire et rend le focus à la bascule                                                                              |
| Fidélité VT (images kitty de files, souris, séquences rares)                        | voir section 4 ; v2 par diffs de cellules OpenTUI                                                                        |

## 7. Plan d'implémentation dans `src/`

Chaque étape est mergeable seule et garde `bun run verify` et les smokes PTY verts.

| Étape | Contenu                                                                                                                                                                                                                          | Fichiers                                                                       | Estimation |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------- |
| 1     | Préfixe d'instance : `registerModules`, `x-airtty-instance` (Transport, Server, manifeste préfixé en cache borné), `actionReference` lié au pane, fin de `current` ; tests à deux panes du même build et de deux builds (O1, O2) | `flight/client.ts`, `client.tsx`, `transport.ts`, `server.ts`, `tests/`        | 3 j        |
| 2     | Export `<Embed>` : keymap par pane, boundary, focus rendu à la bascule (O3, O4) ; test inline à deux apps (repris du probe)                                                                                                      | `client.tsx` (ou `embed.tsx`), `tests/`                                        | 3 j        |
| 3     | Sortie `.airtty/app/` : bundle sans runtime, audit des built-ins, refus du TLA ; `airtty.capabilities` (schéma Zod partagé, recopié dans le manifeste, comparé à l'audit) ; runtime bundlé ; `src/abi.ts`                        | `build.ts` (ajout localisé), `abi.ts`, `capabilities.ts`                       | 3,5 j      |
| 4     | Signature (`airtty keys`, `airtty build --sign-bundle`), routes `/manifest` et `/bundle`                                                                                                                                         | `commands/keys.ts`, `server.ts` (2 routes), `sign.ts`                          | 2 j        |
| 5     | Client générique branché sur le lanceur de feat/distribution (étape URL ; paquets installés, npm, git par le même chargeur) : TOFU, cache, stockage par origine, onglets, bascule clavier ; mode `inline` et son avertissement   | module du lanceur (feat/distribution), `generic/*`, `session.ts`, `connect.ts` | 4 j        |
| 6     | Mode `process` : widget VT, PTY, clavier/souris/resize, multiplexeur local (shell, vim, apps airtty)                                                                                                                             | `vt/*`                                                                         | 5–8 j      |
| 7     | Mode `sandbox` macOS : profil généré depuis `airtty.capabilities`, proxy de sortie, IPC des capacités médiées, écran des capacités, flags `--allow-*`                                                                            | `sandbox/*`                                                                    | 6–8 j      |
| 8     | Sandbox Linux : lanceur Rust Landlock + seccomp (décision 6), repli bwrap ; CI Linux                                                                                                                                             | `sandbox/linux.ts`, lanceur natif                                              | 5–7 j      |

Total : 31,5–38,5 jours (auparavant 31–38). Détail de l'écart :

- étape 1, +1 j : le préfixe d'instance touche aussi le Transport et le Server ;
- étape 3, +0,5 j : le champ `capabilities` et sa comparaison avec l'audit ;
- étape 5, −1 j : pas de commande ni d'analyse d'arguments, le lanceur les fournit.

Dépendances : l'étape 5 suit le merge de feat/distribution (lanceur, champ `airtty`).
Les étapes 1 à 4 n'en dépendent pas. L'ordre de merge prévu (use-cache → devtools →
distribution) le permet. Les étapes 1–2 profitent aussi aux applications actuelles
(tests à plusieurs Applications, boundary).

### Avancement

- **Étape 5 (Client générique)** : livrée sur `feat/embed-generic` (`src/generic/`).
  `airtty <url> [<url>…] [--inline] [--yes]` : l'étape URL du lanceur prépare chaque
  origine dans le processus du lanceur, qui a encore le terminal pour ses questions
  (`prepare.ts`) : `GET /manifest`, signature exigée, clé ABI, épinglage TOFU par
  origine (empreinte affichée, question au premier usage ; clé changée → refus avec
  `airtty trust <origine> <empreinte>`), puis `GET /bundle/<sha256>` en cache sous
  `$XDG_CACHE_HOME/airtty/bundles/<sha256>.cjs`. Par origine, sous
  `$XDG_STATE_HOME/airtty/origins/<sha256(origine)>/` : `origin.json` (clé épinglée, mode,
  capacités acceptées), `app/` (manifeste reçu, lien vers le cache), `sessions/`.
  L'origine est l'URL donnée, normalisée (schéma, hôte, port ; chemin pour ssh), jamais
  l'adresse d'un tunnel. Puis l'app hôte `src/generic/browser` (construite et lancée comme
  l'interface du lanceur) ouvre chaque origine dans un onglet `<Embed>` et revérifie la
  signature contre la clé épinglée. **Mode par défaut** : le `sandbox` n'existant pas,
  une URL ne s'ouvre qu'après un choix explicite `--inline` (mémorisé par origine) ; sans
  lui, refus expliqué. L'avertissement « Confiance totale : … » et les capacités déclarées
  (non appliquées) sont affichés avant chaque ouverture. Écarts : le bearer reste en
  mémoire, par Application donc par origine, comme dans `run()` : le framework n'écrit
  jamais de bearer sur disque et l'étape n'a pas changé cette règle ; `--process` n'est
  pas proposé (il donnerait les mêmes droits qu'`inline`, avec un enfant de plus).

### Limites connues

- Un binaire compilé (`airtty build --compile`) n'embarque pas `.airtty/app/` : son
  Server répond 404 à `/manifest` et `/bundle/…`, il ne peut pas être ouvert par URL.
- L'épinglage est par origine : un Server qui change de port ou d'hôte est une nouvelle
  origine (nouvelle question, nouvelle clé épinglée).

- **Étape 4 (signature, routes, O6)** : livrée sur `feat/embed-sign`. Clé d'éditeur
  Ed25519 (`src/publisher.ts`) : `airtty keys [generate]` (empreinte `SHA256:…` comme
  ssh), fichier `$XDG_CONFIG_HOME/airtty/keys/publisher.pem` (ou `AIRTTY_PUBLISHER_KEY`),
  0600 dans un répertoire 0700, refusée si d'autres peuvent la lire, jamais remplacée
  par `generate`. `airtty build --sign-bundle` (implique `--app-bundle`) signe un encodage
  canonique : préfixe de domaine puis tableau ordonné des champs, `capabilities` à clés
  triées, clé publique comprise. Le Server sert `GET /manifest` (texte écrit par le
  build, `no-cache`) et `GET /bundle/<sha256>` (`immutable`) avant la session et le
  contrôle de build ; sans bundle, 404. `loadAppBundle` vérifie toute signature présente
  et offre `publisher: { required, trust }`, où l'étape 5 branchera l'épinglage par
  origine. Écart : `/bundle` porte le hash dans son chemin (une URL = un contenu, d'où
  `immutable`).

- **Étape 3 (bundle d'application, ABI, capacités, O5)** : livrée sur `feat/embed-bundle`.
  `airtty build` produit `.airtty/app/` (troisième rôle du build, traité comme le Client
  pour les frontières : `index.cjs` `bun-cjs` + `manifest.json` non signé). `src/abi.ts` :
  11 spécifiers, `ABI_VERSION` 1, versions épinglées (un test les compare à
  `package.json`), clé `1-<sha256 court>`. Audit des built-ins par le metafile ;
  top-level await : pas de `.airtty/app/`, avertissement avec fichier et ligne, le Client
  et le Server construits comme avant (échec seulement avec `--app-bundle`) ;
  `airtty.capabilities` (schéma de
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
  `x-airtty-instance` ; le Server passe à Flight une copie du manifeste préfixée par clé
  (cache borné à 64 copies, analyse paresseuse), dans le flux imbriqué de la page comme
  dans l'enveloppe ; `registerModules(key, resolver)` remplace `installResolver`, dans un
  registre partagé par toutes les copies du runtime (`globalThis`). `let current` est
  supprimé : le build émet par bundle un module `airtty:actions` (`createActions()` de
  `airtty/client`) que les stubs `"use server"` importent et que `createApp` lie à
  l'Application qu'il crée. Écart : cette liaison par bundle touche `src/build.ts`
  (≈ 15 lignes) ; elle sert telle quelle aux bundles du Client générique (étape 3), sans
  table `require` à surcharger. Deux panes d'un même build = deux évaluations du bundle.

- **Étape 6 (mode `process`)** : livrée sur `feat/embed-process`, avant l'étape 1 (use-cache
  et distribution modifiaient alors `server.ts`, `transport.ts` et `client.tsx`).
  `<Terminal>` dans `airtty/client` (`src/vt/`), exemple `examples/mux`, smoke
  `test:pty:mux`. Écarts : la touche préfixe est une prop du terminal (le keymap passe
  avant le renderable focalisé, le terminal doit savoir laquelle laisser) ; `run()` ne
  quitte plus sur un `Ctrl+C` déjà traité (sinon `Ctrl+C` dans un shell quitterait le
  multiplexeur). OSC 8 reste non rendu ; Linux non vérifié ; pas de Windows.

## 8. Décisions

Tranchées le 24 septembre 2026 sur les questions ouvertes de la première version de ce
document.

1. **Pane embarquable** : un nouvel export `<Embed>`, pas de nouvelles props sur `Shell`
   (O3, étape 2).
2. **Point d'entrée** : pas de nouvelle commande ; `airtty https://…` passe par le lanceur
   de feat/distribution (chemin → installé → npm → git → URL), sur lequel se branche le
   Client générique (section 2, étape 5).
3. **Capacités** : déclarées statiquement dans `airtty.capabilities` du `package.json`,
   lisibles avant toute exécution ; le build les recopie dans le manifeste signé
   (section 1, étapes 3 et 7).
4. **Deux origines ou deux instances du même build** : préfixe par instance dès
   maintenant (O1 ; probe `panes/instance`, étape 1).
5. **Accès Node sensibles en `inline`** : autorisés ; `inline` = confiance totale,
   capacités non appliquées, et le lanceur l'affiche explicitement (section 1, étape 5).

6. **Sandbox Linux** : un **lanceur natif en Rust** (`airtty-sandbox`, livré compilé avec
   airtty) applique lui-même Landlock (fichiers, exécution par binaire, ports TCP depuis
   l'ABI 4 / noyau 6.7 : sortie réseau forcée vers le proxy de l'hôte sans namespace) et
   seccomp (TIOCSTI, `ptrace`…), puis `exec` l'enfant. Pas de dépendance à bwrap ni à
   `landrun`, pas besoin des user namespaces (restreints par AppArmor sur Ubuntu ≥ 23.10).
   Noyau sans Landlock suffisant : bwrap s'il est présent, sinon le mode `sandbox` est
   **refusé** avec un message clair, jamais simulé.

Question restante, sans effet sur l'API publique : la forme exacte du message du lanceur
en `inline`, à régler avec feat/distribution.
