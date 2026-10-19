# Mode desktop

Une application luciole peut remplir une fenêtre à elle, comme une app de bureau, plutôt
qu'un onglet de terminal. L'hôte (la fenêtre) lance le binaire de l'app sur un PTY et en
affiche l'écran ; le Client, lui, sait qu'il n'est plus dans un terminal partagé.

## Le contrat : `LUCIOLE_DESKTOP=1`

L'hôte pose `LUCIOLE_DESKTOP=1` dans l'environnement du binaire. Le lanceur (binaire
à deux rôles, [DISTRIBUTION.md](DISTRIBUTION.md)) la transmet au Client, et le Client
générique à ses onglets sandboxés. Sous cette variable :

| Geste                             | Terminal                      | Fenêtre desktop                                      |
| --------------------------------- | ----------------------------- | ---------------------------------------------------- |
| Ctrl+C                            | Quitte (session supprimée)    | Touche de l'application, comme une autre             |
| Terminal / fenêtre fermé (SIGHUP) | Interruption : session gardée | Sortie volontaire : session supprimée, Server quitté |
| SIGTERM, SIGINT (arrêt, `kill`)   | Interruption : session gardée | Interruption : session gardée                        |
| `app.quit()`                      | Sortie volontaire             | Sortie volontaire                                    |

Dans un terminal, le fermer n'est pas quitter l'application : l'utilisateur ferme un
onglet, l'app reprend où elle en était au prochain lancement. Une fenêtre desktop _est_
l'application : la fermer (ou Cmd+Q) raccroche son PTY, et c'est le quit de
l'utilisateur. Le Server local s'arrête alors aussitôt au lieu d'attendre son délai de
grâce (`POST /lifetime/leave`, `src/launcher/lifetime.ts`).
Ce contrat vaut dès le démarrage, avant même le premier écran : le lanceur et le
Client partagent le traitement du hangup. Si aucun Server n'a encore été lancé,
la fermeture quitte sans en démarrer un. Si son lancement est en cours, le Client
attend qu'il réponde pour lui envoyer le départ volontaire ; toute session déjà
prise est supprimée. Un second hangup pendant ce départ est ignoré.

Aucun protocole propre à l'hôte : un hangup de PTY est ce que tout émulateur fait en
fermant une fenêtre, donc le contrat vaut pour n'importe quel hôte (Electrobun, WezTerm
ou Ghostty en kiosque, app native). Limite : un hôte qui plante raccroche aussi le PTY,
et la session est alors oubliée comme après un quit.

Les options de l'application (`app/args.ts`) passent comme sur un terminal : l'hôte lance
le binaire avec la ligne de commande de sa configuration, et le binaire les vérifie puis
les transmet à son Server ([DISTRIBUTION.md](DISTRIBUTION.md)). Avec
`"server": "per-launch"`, une fenêtre est un lancement : fermer la fenêtre est un quit,
son Server s'arrête.

Côté code, `run()` lit la variable et crée l'Application avec `quitOnCtrlC: false`
(`ApplicationOptions`) ; `Runtime` ne déclare alors plus `ctrl+c`, et la barre d'aide
générée ne l'affiche plus. Un hôte qui ouvre des panes (`openApplication`) leur passe la
même option.

## Préparer le runtime natif OpenTUI

```sh
luciole native-runtime                              # cible de la machine
luciole native-runtime --target bun-linux-x64-musl    # autre cible
```

La commande prépare un couple JavaScript et bibliothèque native OpenTUI v0.6.6 avec
le patch partagé du défilement en pixels. Elle demande git, le réseau et Zig 0.16.0
au premier lancement ; `ZIG=/chemin/vers/zig` choisit l'exécutable. Sur macOS, le SDK
des Command Line Tools est utilisé par défaut lorsqu'il est installé ; `DEVELOPER_DIR`
permet de choisir un autre SDK.

Les six cibles sont `bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64`,
`bun-linux-arm64`, `bun-linux-x64-musl` et `bun-linux-arm64-musl`. Les bibliothèques
macOS visent macOS 13, celles de Linux glibc visent glibc 2.17 ; les deux autres
emploient musl. Une compilation croisée vers macOS demande aussi son SDK.

Le cache se trouve dans `$XDG_CACHE_HOME/luciole/native/` (ou
`~/.cache/luciole/native/`). Sa clé dépend du tag OpenTUI, des octets des patches
dans leur ordre, de la version de Zig, de la cible et de la version du format.
Une modification du framework seule ne l'invalide pas. Le manifeste
`native-runtime.json` conserve ces données, l'arbre source et les empreintes SHA-256
de chaque fichier, y compris les métadonnées ABI générées. Chaque réutilisation
vérifie ces empreintes, sans Zig ni checkout source. Une entrée manquante ou altérée
est reconstruite par cette commande ; deux préparations concurrentes partagent un verrou
et l'entrée complète devient visible par un renommage atomique.

`luciole build --compile` embarque le couple préparé pour sa cible, JavaScript et
bibliothèque native ensemble. Il ne lance jamais Zig ni la préparation. Sans entrée
complète (cache vide ou altéré), il conserve OpenTUI standard et le défilement par
lignes, avec un avertissement donnant la commande de préparation. Le stage desktop
transmet cet avertissement et continue son build ; après préparation, il faut le relancer.
Les builds sans `--compile` gardent leur comportement habituel. Pour une cible étrangère
sans entrée préparée, `--native-dir` reste disponible.

## L'hôte Electrobun : `packages/desktop`

Un prototype d'hôte : une fenêtre [Electrobun](https://framework.blackboard.sh/electrobun/)
dont le processus principal est Bun (`build.mainProcess: "bun"`), et une vue xterm.js
dans le webview du système. Electrobun 2 prend par défaut Cottontail, son propre runtime
(JavaScriptCore, API Bun) : il a `Bun.Terminal` et un vrai PTY, mais pèse autant que Bun
(~60 Mo) et `@luciole-sh/core/pty` n'a été éprouvé que sous Bun.

```text
fenêtre (webview système)          processus principal (Bun)            PTY
┌────────────────────────┐  RPC   ┌──────────────────────────┐        ┌──────────────┐
│ xterm.js : rendu,      │ ─────▶ │ src/host/session.ts      │ ─────▶ │ bin/<app>    │
│ clavier, souris, coller│ ◀───── │ spawnPty (@luciole-sh/core/pty),   │ ◀───── │ LUCIOLE_      │
└────────────────────────┘ output │ UTF-8 décodé, par tour   │        │ DESKTOP=1    │
                                  └──────────────────────────┘        └──────────────┘
```

| Fichier                     | Rôle                                                                        |
| --------------------------- | --------------------------------------------------------------------------- |
| `scripts/stage.ts`          | Build, binaire à deux rôles, métadonnées et icône (iconset macOS) du stage  |
| `electrobun.config.ts`      | Nom, identifiant, version et icône de l'app ; main Bun, vue, binaire copié  |
| `scripts/single-runtime.ts` | Hook `postBuild` : le binaire de l'app exécute aussi l'hôte (un seul Bun)   |
| `scripts/smoke.ts`          | Ouvre le bundle construit comme sur un Mac neuf et vérifie toute la chaîne  |
| `src/host/session.ts`       | PTY ↔ vue, sans Electrobun : testé par `tests/desktop-session.test.ts`      |
| `src/host/index.ts`         | Fenêtre, RPC, menus (Cmd+Q, Cmd+W, copier, coller), hangup à la fermeture   |
| `src/view/index.ts`         | xterm.js (WebGL si disponible), taille ajustée à la fenêtre                 |
| `src/protocol.ts`           | Messages RPC : `open`, `input`, `resize` vers l'hôte ; `output` vers la vue |

```sh
cd packages/desktop
bun run stage ../../examples/notes          # build + binaire portable (Bun officiel)
bunx electrobun dev                         # build de dev et lancement
bun run build                               # build stable : build/, artifacts/
bun run smoke                               # lance le bundle construit et le vérifie
bun run check                               # SDK projeté (.hutch/devkit) + tsc
```

La première commande Electrobun télécharge Hutch (son outil de build) dans `~/.hutch` ;
le SDK n'est pas sur npm, il est projeté dans `.hutch/devkit` (ignoré par git). C'est
pourquoi `bun run check` et `bun run lint` à la racine laissent de côté les fichiers
qui importent ce SDK : `bun run check` du package les vérifie, SDK projeté. Sans app
stagée, la configuration se charge quand même ; seul un build la réclame.

Le stage compile toujours avec `--portable` : un runtime qui lie autre chose que les
bibliothèques du système (un Bun de Nix ou de Homebrew, `--runtime host`) échoue là
plutôt que sur le Mac de l'utilisateur. Rien dans le bundle ne cherche un Bun installé.

### Un seul Bun

Le binaire de l'app (`luciole build --compile`) embarque un Bun complet, et Electrobun en
livre un autre pour l'hôte. Le hook `postBuild` (`scripts/single-runtime.ts`), exécuté
avant qu'Electrobun ne signe le bundle, fait tourner l'hôte sur le binaire de l'app :

```text
Contents/MacOS/launcher      natif Electrobun : lance « bun main.js »
Contents/MacOS/bun           script : BUN_BE_BUN=1 exec ./<app> "$@"
Contents/MacOS/<app>         le binaire de l'app, à côté des bibliothèques d'Electrobun
Contents/MacOS/native/luciole-pty   lanceur natif du PTY, signé avec l'app
Contents/MacOS/native/       les paquets natifs éventuels, à côté du binaire

launcher ─▶ <app> en Bun (hôte, main.js) ─▶ <app> (Client, sur le PTY) ─▶ <app> serve
```

Le binaire compilé ignore son programme sous `BUN_BE_BUN=1` et se comporte comme `bun` ;
l'hôte le lance ensuite sans cette variable (`src/host/session.ts`). Il est déplacé dans
`MacOS/` parce qu'Electrobun charge ses bibliothèques à côté de l'exécutable en cours.
L'hôte lance directement `MacOS/<app>` sur macOS. `native/` est un vrai répertoire :
l'extracteur du bundle compacté d'Electrobun ne conserve pas les liens symboliques.
Le bundle passe de 140 à 80 Mo (55 à 31 Mo en zip). En contrepartie, Electrobun tourne
sur le Bun de l'app (1.4.2) plutôt que sur celui qu'il fixe (1.4.0) : `bun run smoke`
le vérifie après chaque build. Le smoke lance une copie temporaire du bundle stable
compacté (`Resources/<hash>.tar.zst`) : le lanceur Electrobun 2.0.2 l'extrait sur place,
et le build reste intact. Avec un HOME privé et le seul PATH système, il vérifie le
lanceur PTY signé dans `MacOS/native/luciole-pty`, le runtime de l'hôte et le groupe
de premier plan du Client (TPGID = pid). Il attend le mode brut du PTY, activé par
le renderer après l'installation des handlers de signaux, puis quitte par Cmd+Q
(System Events doit autoriser l'automatisation). Le Server doit journaliser le départ
volontaire du dernier Client ; tous les processus, la copie extraite et les données
temporaires sont supprimés. `bun run smoke /chemin/Notes.app` choisit un autre bundle
stable compacté. macOS seulement ; ailleurs le bundle garde ses deux Bun.

Sur macOS, `luciole-pty` attache le PTY comme terminal de contrôle, puis remplace
son processus par le programme. Le noyau envoie ainsi SIGWINCH après un redimensionnement
et SIGINT au groupe de premier plan quand le PTY reçoit Ctrl+C. Le lanceur corrige le
cas de Bun 1.4.x où un `Bun.Terminal` alloué avant le spawn reste sans terminal de contrôle.
Le stage contient le lanceur universel (arm64 et x86_64, macOS 13 ou plus) dans `native/` ;
le stage le signe avec le binaire de l’app (`--sign`, signature ad hoc par défaut).
Le hook du build vérifie sa signature avant la signature du bundle. Aucun compilateur n'est requis à l'installation.

L'app tourne dans son répertoire de données (`Utils.paths.userData`,
`~/Library/Application Support/<identifier>/…`) : ce qu'elle écrit par chemin relatif
lui reste, jamais dans le répertoire de l'utilisateur ni dans le bundle.

Vérifié à la main sur macOS (arm64), avec `examples/notes` : rendu OpenTUI fidèle
(couleurs, cadres, curseur), Ctrl+C sans effet, Entrée et la saisie vont à l'app, coller
(Cmd+V) de l'Unicode, CJK en double largeur compris ; Cmd+W, Cmd+Q ou le menu Close
arrêtent le Client et le Server géré aussitôt, et suppriment la session.

Le bundle prend ce que l'app déclare d'elle-même (métadonnées, [API.md](API.md)) :
`displayName` nomme l'app (`Notes.app`, titre de fenêtre, menus), `identifier` devient
son identifiant de bundle (`dev.luciole.desktop.<app>` sinon), `version` et `description`
viennent de son `package.json`. L'icône devient un iconset sur macOS (`sips`, puis
`iconutil` par Electrobun), un PNG sous Windows et Linux.

Limites connues du prototype :

- Une app par build : le stage est unique.
- Pas de signature ni de notarisation : `build.mac.codesign` et `notarize`
  d'Electrobun, à relier à `--sign` du binaire embarqué (`src/sign.ts`). Electrobun
  n'écrit pas non plus `CFBundleShortVersionString` dans l'`Info.plist`.
- Signature et notarisation du script `MacOS/bun` non essayées : si la notarisation le
  refuse, un lanceur compilé minuscule le remplacera.
- La frappe d'accents par `osascript keystroke` arrive fausse ; le collage passe. À
  confirmer au clavier réel, touches mortes et méthodes de saisie comprises.
- Linux et Windows non essayés ; Windows n'a pas de PTY dans Bun (`src/vt/pty.ts`).
