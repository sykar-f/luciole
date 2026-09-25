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
dont le processus principal est Bun (`build.mainProcess: "bun"` ; Electrobun 2 prend
Cottontail par défaut, qui n'a pas `Bun.Terminal`), et une vue xterm.js dans le webview
du système.

```text
fenêtre (webview système)          processus principal (Bun)            PTY
┌────────────────────────┐  RPC   ┌──────────────────────────┐        ┌──────────────┐
│ xterm.js : rendu,      │ ─────▶ │ src/host/session.ts      │ ─────▶ │ bin/<app>    │
│ clavier, souris, coller│ ◀───── │ spawnPty (airtty/pty),   │ ◀───── │ AIRTTY_      │
└────────────────────────┘ output │ UTF-8 décodé, par tour   │        │ DESKTOP=1    │
                                  └──────────────────────────┘        └──────────────┘
```

| Fichier                | Rôle                                                                        |
| ---------------------- | --------------------------------------------------------------------------- |
| `scripts/stage.ts`     | Build de l'app et binaire à deux rôles dans `.stage/bin`, `.stage/app.json` |
| `electrobun.config.ts` | Nom de l'app (du stage), main Bun, vue `terminal`, copie du binaire         |
| `src/host/session.ts`  | PTY ↔ vue, sans Electrobun : testé par `tests/desktop-session.test.ts`      |
| `src/host/index.ts`    | Fenêtre, RPC, menus (Cmd+Q, Cmd+W, copier, coller), hangup à la fermeture   |
| `src/view/index.ts`    | xterm.js (WebGL si disponible), taille ajustée à la fenêtre                 |
| `src/protocol.ts`      | Messages RPC : `open`, `input`, `resize` vers l'hôte ; `output` vers la vue |

```sh
cd packages/desktop
bun run stage ../../examples/notes          # build + binaire (runtime Bun officiel)
bun run stage ../../examples/notes --runtime host   # hors ligne, pour essayer ici
bunx electrobun dev                         # build de dev et lancement
bun run build                               # build stable : build/, artifacts/
bun run check                               # SDK projeté (.hutch/devkit) + tsc
```

La première commande Electrobun télécharge Hutch (son outil de build) dans `~/.hutch` ;
le SDK n'est pas sur npm, il est projeté dans `.hutch/devkit` (ignoré par git). C'est
pourquoi `bun run check` à la racine ne vérifie pas `packages/desktop`.

Vérifié à la main sur macOS (arm64), avec `examples/notes` : rendu OpenTUI fidèle
(couleurs, cadres, curseur), Ctrl+C sans effet, Entrée et la saisie vont à l'app, coller
(Cmd+V) de l'Unicode, CJK en double largeur compris ; Cmd+W, Cmd+Q ou le menu Close
arrêtent le Client et le Server géré aussitôt, et suppriment la session.

Limites connues du prototype :

- Une app par build : le stage est unique, l'identifiant `dev.airtty.desktop.<app>`.
- Pas d'icône (`icon.iconset`), pas de signature ni de notarisation : `build.mac.codesign`
  et `notarize` d'Electrobun, à relier à `--sign` du binaire embarqué (`src/sign.ts`).
- Le bundle pèse ~140 Mo : Bun pour l'hôte, plus le binaire de l'app qui embarque le sien.
  Cottontail pour l'hôte (s'il gagne un PTY) ou un Client seul (`--client-only`)
  réduiraient cela.
- La frappe d'accents par `osascript keystroke` arrive fausse ; le collage passe. À
  confirmer au clavier réel, touches mortes et méthodes de saisie comprises.
- Linux et Windows non essayés ; Windows n'a pas de PTY dans Bun (`src/vt/pty.ts`).
