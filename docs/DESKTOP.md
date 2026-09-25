# Mode desktop

Une application airtty peut remplir une fenêtre à elle, comme une app de bureau, plutôt
qu'un onglet de terminal. L'hôte (la fenêtre) lance le binaire de l'app sur un PTY et en
affiche l'écran ; le Client, lui, sait qu'il n'est plus dans un terminal partagé.

## Le contrat : `AIRTTY_DESKTOP=1`

L'hôte pose `AIRTTY_DESKTOP=1` dans l'environnement du binaire. Le lanceur (binaire
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

Aucun protocole propre à l'hôte : un hangup de PTY est ce que tout émulateur fait en
fermant une fenêtre, donc le contrat vaut pour n'importe quel hôte (Electrobun, WezTerm
ou Ghostty en kiosque, app native). Limite : un hôte qui plante raccroche aussi le PTY,
et la session est alors oubliée comme après un quit.

Côté code, `run()` lit la variable et crée l'Application avec `quitOnCtrlC: false`
(`ApplicationOptions`) ; `Runtime` ne déclare alors plus `ctrl+c`, et la barre d'aide
générée ne l'affiche plus. Un hôte qui ouvre des panes (`openApplication`) leur passe la
même option.

## L'hôte Electrobun : `packages/desktop`

Un prototype d'hôte : une fenêtre [Electrobun](https://framework.blackboard.sh/electrobun/)
dont le processus principal est Bun (`build.mainProcess: "bun"`), et une vue xterm.js
dans le webview du système. Electrobun 2 prend par défaut Cottontail, son propre runtime
(JavaScriptCore, API Bun) : il a `Bun.Terminal` et un vrai PTY, mais pèse autant que Bun
(~60 Mo) et `airtty/pty` n'a été éprouvé que sous Bun.

```text
fenêtre (webview système)          processus principal (Bun)            PTY
┌────────────────────────┐  RPC   ┌──────────────────────────┐        ┌──────────────┐
│ xterm.js : rendu,      │ ─────▶ │ src/host/session.ts      │ ─────▶ │ bin/<app>    │
│ clavier, souris, coller│ ◀───── │ spawnPty (airtty/pty),   │ ◀───── │ AIRTTY_      │
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

Le binaire de l'app (`airtty build --compile`) embarque un Bun complet, et Electrobun en
livre un autre pour l'hôte. Le hook `postBuild` (`scripts/single-runtime.ts`), exécuté
avant qu'Electrobun ne signe le bundle, fait tourner l'hôte sur le binaire de l'app :

```text
Contents/MacOS/launcher      natif Electrobun : lance « bun main.js »
Contents/MacOS/bun           script : BUN_BE_BUN=1 exec ./<app> "$@"
Contents/MacOS/<app>         le binaire de l'app, à côté des bibliothèques d'Electrobun
Resources/app/airtty/bin/<app> → lien vers MacOS/<app>, que l'hôte lance sur le PTY

launcher ─▶ <app> en Bun (hôte, main.js) ─▶ <app> (Client, sur le PTY) ─▶ <app> serve
```

Le binaire compilé ignore son programme sous `BUN_BE_BUN=1` et se comporte comme `bun` ;
l'hôte le lance ensuite sans cette variable (`src/host/session.ts`). Il est déplacé dans
`MacOS/` parce qu'Electrobun charge ses bibliothèques à côté de l'exécutable en cours.
Le bundle passe de 140 à 80 Mo (55 à 31 Mo en zip). En contrepartie, Electrobun tourne
sur le Bun de l'app (1.4.2) plutôt que sur celui qu'il fixe (1.4.0) : `bun run smoke`
le vérifie après chaque build. macOS seulement ; ailleurs le bundle garde ses deux Bun.

L'app tourne dans son répertoire de données (`Utils.paths.userData`,
`~/Library/Application Support/<identifier>/…`) : ce qu'elle écrit par chemin relatif
lui reste, jamais dans le répertoire de l'utilisateur ni dans le bundle.

Vérifié à la main sur macOS (arm64), avec `examples/notes` : rendu OpenTUI fidèle
(couleurs, cadres, curseur), Ctrl+C sans effet, Entrée et la saisie vont à l'app, coller
(Cmd+V) de l'Unicode, CJK en double largeur compris ; Cmd+W, Cmd+Q ou le menu Close
arrêtent le Client et le Server géré aussitôt, et suppriment la session.

Le bundle prend ce que l'app déclare d'elle-même (métadonnées, [API.md](API.md)) :
`displayName` nomme l'app (`Notes.app`, titre de fenêtre, menus), `identifier` devient
son identifiant de bundle (`dev.airtty.desktop.<app>` sinon), `version` et `description`
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
