# Widget VT : un PTY dans un arbre OpenTUI

Exécuté le 24 septembre 2026 sur macOS arm64 (Darwin 25.6), Bun 1.4.2, OpenTUI
Core/React 0.5.12, React 19.3.0. Les versions des émulateurs évalués sont fixées
dans `package.json` et `bun.lock`. Toutes les mesures citées ici viennent de
`results.json`, écrit par les scripts eux-mêmes.

Question : les modes `process` et `sandbox` de luciole peuvent-ils afficher un enfant
(shell, vim, autre app luciole) comme un composant parmi d'autres, avec clavier,
souris et redimensionnement, sans dépendance lourde ni coût de rendu prohibitif ?
Réponse : **oui**. OpenTUI 0.5.12 embarque déjà libghostty-vt dans `libopentui`
(`EmbeddedTerminalRenderable`), et `Bun.Terminal` fournit le PTY. Deux trous
d'OpenTUI sont comblés dans `gaps.ts` en attendant un correctif amont.

## Reproduire

```sh
cd probes/vt-embed
bun install --frozen-lockfile   # émulateurs de comparaison seulement ; OpenTUI vient de la racine
bun widget-probe.tsx            # widget : 15 assertions sur un vrai shell, vim et une app OpenTUI
bun bench.tsx                   # débit, coût de frame, mémoire, taille, puis fidélité (≈ 2 min)
bun fidelity.ts                 # fidélité seule, lisible
bun v2-estimate.ts              # esquisse v2 : diffs de cellules comparés au flux VT
bun demo.tsx                    # démo manuelle : $SHELL | vim, Ctrl-O focus, Ctrl-Q quitter
```

Ses dépendances ne sont pas installées par `bun install` à la racine : `bun run verify`
exclut donc ce dossier (`tsconfig.json` et `.oxlintrc.json` racine), pour passer sur un
checkout neuf et en CI. Il se vérifie à part, après son `bun install` :

```sh
cd probes/vt-embed && bun run check   # tsc -p . (tsconfig.json local) + oxlint -c oxlint.json
```

`oxlint.json` étend la config racine ; il ne s'appelle pas `.oxlintrc.json` pour qu'oxlint,
lancé à la racine, ne le découvre pas et ne relinte pas ce dossier.

`bunfig.toml` désactive l'installation des peers : `@opentui/core` et `react` se
résolvent depuis la racine du dépôt, donc une seule instance de React et d'OpenTUI.
Les flux mesurés sont enregistrés une fois dans `.out/streams/` (ignoré par git).

| Fichier             | Rôle                                                                             |
| ------------------- | -------------------------------------------------------------------------------- |
| `pty.ts`            | `spawnPty` : `Bun.Terminal` + `detached: true`                                   |
| `vt-view.tsx`       | `<VtView>` : PTY + `EmbeddedTerminalRenderable`, focus, taille suivant le layout |
| `gaps.ts`           | touches legacy manquantes ; réponses DA1, DA2, OSC 10/11                         |
| `widget-probe.tsx`  | test headless (`testRender`) du widget                                           |
| `demo.tsx`          | deux panneaux côte à côte, dans un vrai terminal                                 |
| `child-opentui.tsx` | app OpenTUI minimale lancée dans le widget (cas luciole `process`)               |
| `emulators.ts`      | un adaptateur par émulateur headless                                             |
| `streams.ts`        | flux réels (`seq`, `ls --color`, vim) et log ANSI synthétique                    |
| `bench.tsx`         | performances ; `fidelity.ts` fidélité ; `v2-estimate.ts` bande passante v2       |

## PTY : `Bun.Terminal`, avec `detached: true`

Bun 1.4.2 a un PTY natif (`Bun.spawn({ terminal })`, `Bun.Terminal` : `write`,
`resize`, termios). Il n'y a besoin ni de node-pty ni d'addon natif. La
documentation le limite à POSIX : pas de Windows.

Piège mesuré : sans `detached: true`, le PTY n'est **pas** le terminal de contrôle
de l'enfant. `ps` affiche `TT ??` et `sh` avertit « no job control ». Ctrl-C
(ISIG) ne trouve alors aucun groupe de processus au premier plan : un `sleep 30`
y survit. Avec `detached: true`, Bun appelle `setsid()` et fait du PTY le terminal
de contrôle. On obtient `TT s038` et `TPGID` renseigné, et Ctrl-C termine le job
avec le statut 130. Un lanceur Python `setsid` + `TIOCSCTTY` donnait le même
résultat ; il est devenu inutile.

## Le widget

`<VtView argv focused …>` crée l'`EmbeddedTerminalRenderable` impérativement sous
un `<box>` React. `extend()` aurait modifié un catalogue global et imposé une
augmentation JSX globale, ce qu'un runtime partagé entre plusieurs apps ne doit
pas faire. Le programme démarre au **premier layout**, à sa vraie taille. Chaque
changement de layout redimensionne l'émulateur, qui reflowe, puis le PTY
(`TIOCSWINSZ` → `SIGWINCH`). L'émulateur produit deux sortes d'octets, tous deux
renvoyés au PTY : les entrées encodées (clavier, souris, collage, focus) et les
réponses aux requêtes du programme.

Le rendu passe par `renderSelf()`, qui compose la grille libghostty directement
dans le buffer OpenTUI, en natif et sans une ligne de JS par cellule. C'est le
chemin le plus rapide mesuré (voir plus bas).

Le routage clavier fonctionne sans couche de keymap. Les écouteurs globaux
(`useKeyboard`) passent **avant** le renderable focalisé, et `preventDefault()`
empêche la touche de l'atteindre (`InternalKeyHandler.emitWithPriority`). Une
touche préfixe hôte (Ctrl-O dans la démo) est donc possible. En contrepartie,
**tout raccourci global d'une app luciole hôte est volé au terminal embarqué**.
Le keymap de luciole devra être scopé au focus.

Assertions de `widget-probe.tsx`, toutes vertes (valeurs issues de `results.json`) :

| Assertion                                                                      | Mesure                  |
| ------------------------------------------------------------------------------ | ----------------------- |
| taille du PTY = zone intérieure du cadre                                       | 98×18 dans 100×20       |
| pas de « no job control »                                                      |                         |
| écho d'une frappe                                                              | 12 ms (frappe → frame)  |
| encodage : Ctrl-A, Alt-x, ↑, F1, F5, Tab, Backspace, Entrée                    | séquences xterm exactes |
| DECCKM : ↑ devient `ESC O A`                                                   |                         |
| collage entouré de `ESC[200~`…`ESC[201~` seulement après `?2004h`              |                         |
| souris : rien par défaut ; SGR 1006 après `?1000h ?1006h`, coordonnées locales | `ESC[<0;4;3M` / `m`     |
| DA1, DA2, OSC 11 (via `gaps.ts`) et DSR (natif) répondus au PTY                |                         |
| Ctrl-C interrompt le job au premier plan                                       | statut 130              |
| redimensionnement vu par le programme (`stty size`)                            | 28 138                  |
| `seq 1 100000` à travers tout le chemin PTY → libghostty → frame               | 689 Ko en 43 ms         |
| vim : écran alternatif, insertion, `:q!` restaure l'écran du shell             | vim prêt en 202 ms      |
| app OpenTUI enfant : démarre, reçoit les touches, rend l'écran                 | prête en 91 ms          |
| deux vues côte à côte : Ctrl-O change le focus et n'atteint aucun PTY          |                         |

La démo a aussi été pilotée dans un vrai PTY (imbriqué, rendu par libghostty-vt) :
`echo` à gauche, Ctrl-O, saisie dans vim à droite, Ctrl-Q, sortie 0.

### Trous d'OpenTUI 0.5.12 (à remonter en amont), comblés par `gaps.ts`

1. **Touches en protocole clavier legacy** (tout terminal sans drapeaux kitty,
   et les mocks de test) :
   - F1–F12 ne produisent rien : `physicalKey()` renvoie `key.code` tel quel
     (`"OP"`, `"[15~"`) et sa table ignore `f5`… ;
   - Alt+x ne produit rien : le parseur legacy marque ESC-x comme `meta`, que
     `modifiers()` traduit en SUPER, touche que l'encodeur libghostty abandonne ;
   - **Backspace ne produit rien** : il est impossible d'effacer dans un shell.

   `VtTerminalRenderable.handleKeyPress` garde l'encodage natif chaque fois qu'il
   produit des octets. Cet encodage suit les modes (DECCKM, drapeaux kitty). Le
   correctif ne complète que ces trous avec les séquences xterm. Dans un vrai
   terminal compatible kitty, OpenTUI reçoit des `code` physiques et l'encodage
   natif suffit.

2. **Requêtes sans réponse** : libghostty-vt délègue les attributs de terminal et
   les couleurs à l'embarqueur, et OpenTUI n'enregistre aucun callback. DA1, DA2
   et OSC 10/11 restent donc muets. DSR, DECRQM, XTVERSION (`libghostty`), kitty
   `CSI ? u` et DECRQSS sont répondus. `queryResponder` observe le flux de sortie,
   avec une traîne de 16 octets pour les séquences coupées entre deux lectures,
   et répond. Une app OpenTUI enfant démarrait malgré tout sans le correctif
   (271 ms, mesure ponctuelle hors `results.json`), mais sans connaître le thème
   (OSC 11).

## Émulateurs headless comparés

| Émulateur (version)                                           | Nature                                  | Installé en plus        |
| ------------------------------------------------------------- | --------------------------------------- | ----------------------- |
| **OpenTUI `EmbeddedTerminalRenderable`** (0.5.12)             | libghostty-vt dans `libopentui` (natif) | 0 (déjà dans OpenTUI)   |
| `libghostty-vt` (0.6.3, binding communautaire, pré-1.0)       | libghostty-vt natif via `bun:ffi`       | 18,4 Mo (5 plateformes) |
| `ghostty-web` (0.4.0)                                         | libghostty-vt en WebAssembly (413 Ko)   | 2,1 Mo                  |
| `@xterm/headless` (6.0.0) + `addon-unicode-graphemes` (0.4.0) | JavaScript pur                          | 2,5 Mo                  |
| `ghostty-opentui` (1.5.0)                                     | parseur Ghostty en N-API, rendu de logs | 29,8 Mo (5 plateformes) |

Performances (`bench.tsx`, médianes). Le débit est mesuré en blocs de 4 Kio sur
une instance neuve de 120×40. La frame est une lecture de toutes les cellules
visibles (`extract`), puis le dessin dans un `OptimizedBuffer` par `setCell`
(`draw`). Pour OpenTUI, c'est une composition native forcée
(`invalidate` + `render`).

| Émulateur        | seq Mo/s | ls Mo/s | vim Mo/s | log ANSI Mo/s | frame 80×24         | frame 200×60         | mémoire / instance       |
| ---------------- | -------- | ------- | -------- | ------------- | ------------------- | -------------------- | ------------------------ |
| OpenTUI embarqué | 55       | 81      | 107      | 75            | **61 µs** (composé) | **367 µs** (composé) | ≈ 2,0 Mo natif, 43 Ko JS |
| libghostty-vt    | 77       | 93      | 82       | 61            | 1 160 / 1 147 µs    | 8 442 / 8 582 µs     | 1,2 Mo natif, 76 Ko JS   |
| ghostty-web      | 56       | 28      | 31       | 47            | 29 / 70 µs          | 170 / 425 µs         | 11,6 Mo RSS, 13,9 Mo tas |
| xterm headless   | 30       | 32      | 28       | 57            | 38 / 96 µs          | 75 / 303 µs          | 0,3 Mo RSS, 2,2 Mo tas   |
| ghostty-opentui  | 39       | 87      | 128      | 81            | 179 µs (JSON)       | 250 µs (JSON)        | 2,5 Mo natif             |

Lecture des mesures :

- Pour OpenTUI, la mémoire exclut le renderer de test que l'adaptateur crée pour
  chaque instance : 2 378 Kio mesurés, dont 398 Kio pour ce renderer. Une app
  embarque ses terminaux dans le renderer qu'elle possède déjà.
- ghostty-web tourne avec une instance WebAssembly par terminal, à cause du
  défaut d'isolation décrit plus bas. D'où 14 Mo de tas par instance.
- Le binding libghostty-vt parse vite, mais sa lecture de cellules traverse le FFI
  et alloue un objet par cellule : 8,4 ms pour une frame 200×60, soit la moitié
  d'une frame à 60 Hz.

**Chemin React** (`<text>`/`<span>` par ligne, reconstruit et réconcilié à chaque
frame depuis xterm) : 1 233 µs en 80×24 et 4 256 µs en 200×60. C'est **20 fois
plus lent** que la composition native et, en plus, cela alloue.

Fidélité (`fidelity.ts`, 16 vérifications scriptées, instance neuve 40×10 pour
chaque vérification). « pas d'API » signifie que l'émulateur garde l'état mais ne
permet pas de le lire.

| Vérification                                         | OpenTUI     | libghostty-vt | ghostty-web | xterm     | ghostty-opentui |
| ---------------------------------------------------- | ----------- | ------------- | ----------- | --------- | --------------- |
| écran alternatif 1049                                | ✓           | ✓             | ✓           | ✓         | ✓               |
| zone de défilement DECSTBM                           | ✓           | ✓             | ✓           | ✓         | ✓               |
| CJK et emoji sur deux cellules                       | ✓           | ✓             | ✓           | ✓         | ✓               |
| diacritique combinant dans la cellule de base        | ✓           | ✓             | ✓           | ✓         | ✓               |
| emoji ZWJ en un graphème (mode 2027)                 | ✓           | ✓             | ✓           | ✓ (addon) | ✓               |
| SGR 256, truecolor, gras, inverse                    | ✓ ¹         | ✓             | ✓           | ✓         | ✓               |
| souris 1000 + SGR 1006                               | ✓ ²         | ✓             | ✓           | ✓ ³       | pas d'API       |
| collage entre crochets 2004                          | ✓ ²         | ✓             | ✓           | ✓         | pas d'API       |
| DECCKM                                               | ✓ ²         | ✓             | ✓           | ✓         | pas d'API       |
| forme du curseur DECSCUSR                            | ✓           | pas d'API     | ✗ ignorée   | pas d'API | pas d'API       |
| lien OSC 8 sur ses cellules                          | ✗ ⁴         | ✓             | ✗ URI nulle | pas d'API | pas d'API       |
| réponse DA1                                          | ✗ → gaps.ts | ✓             | ✗           | ✓         | pas d'API       |
| réponse DSR 6n                                       | ✓           | ✓             | ✓           | ✓         | pas d'API       |
| réponse OSC 11                                       | ✗ → gaps.ts | ✗             | ✗           | ✗         | pas d'API       |
| reflow au redimensionnement, curseur sur la ligne    | ✓           | ✓             | ✓           | ✗ ⁵       | ✓               |
| **terminal neuf vierge après libération d'un autre** | ✓           | ✓             | **✗ fuite** | ✓         | ✓               |
| **Total brut**                                       | 13/16       | 14/16         | 11/16       | 12/16     | 8/16            |

1. L'inverse est résolu avant composition : la cellule arrive avec les couleurs
   permutées, sans l'attribut INVERSE.
2. OpenTUI n'expose aucun accesseur de mode. Le mode est observé par ce que
   produisent ses encodeurs.
3. xterm donne le mode de suivi de la souris ; son encodage SGR reste interne.
4. Aucun lien n'est visible dans le buffer composé (`getLinkAt`).
5. xterm.js ne reflowe jamais la ligne du curseur ; il le fait une fois que le
   curseur l'a quittée.

**ghostty-web partage mal son instance WebAssembly.** C'est l'usage documenté,
une instance pour tous les terminaux. Un terminal créé après la libération d'un
autre affiche les cellules de ce dernier : `BECRET-FROM-A` au lieu de `B`. Puis
les écritures échouent en « Out of bounds memory access ». Pour un multiplexeur
qui héberge plusieurs origines, c'est une fuite de contenu entre sessions.

## Recommandation

**Retenir `EmbeddedTerminalRenderable` d'OpenTUI**, enveloppé comme dans
`vt-view.tsx`, avec les correctifs de `gaps.ts` jusqu'à leur intégration en amont.

- **Aucune dépendance.** libghostty est déjà dans `libopentui`, la même
  bibliothèque native que luciole embarque et signe (`--compile`). Rien de plus à
  télécharger, compiler ou notariser.
- **Rendu.** La composition est native : 61 µs en 80×24, 367 µs en 200×60. C'est
  12 à 20 fois moins que le chemin React et 19 à 23 fois moins que `setCell` sur
  libghostty-vt.
- **Débit.** De 55 à 107 Mo/s selon le flux. Le chemin complet mesuré (PTY, émulateur,
  frames) atteint 16 Mo/s sur `seq`, limité par le shell et le PTY.
- **Fidélité.** Les modes et les encodeurs sont ceux de Ghostty : clavier kitty,
  DECCKM, souris SGR, collage, focus. Reflow correct, isolation correcte.
- **Écarts restants.** DA1 et OSC 10/11 sont comblés par `gaps.ts`. Reste OSC 8,
  absent du buffer composé.

Rôle des autres candidats :

- **libghostty-vt** ou **@xterm/headless** conviennent pour lire un écran hors de
  tout rendu : captures pour tests ou DevTools, serveur qui résume une session.
  xterm est portable (JS pur, Windows compris), plus lent à parser, et sa lecture
  de cellules est rapide. Le binding libghostty-vt est pré-1.0 et lent à lire.
- **ghostty-web** est écarté tant que le défaut d'isolation n'est pas corrigé.
- **ghostty-opentui** est un rendu de logs ANSI : il n'expose ni modes ni réponses.

Risques :

- `EmbeddedTerminalRenderable` est récent. Son API et ses trous peuvent changer à
  chaque version d'OpenTUI, que luciole épingle déjà.
- Sonde exécutée seulement sur macOS arm64. Linux n'a pas été exécuté ici :
  `setsid` au lancement détaché y est probable mais non vérifié.
- Windows est sans PTY Bun.

## Esquisse v2 : diffs de buffers de cellules OpenTUI par IPC

Principe : une app luciole enfant en mode `process` pourrait, au lieu d'émuler un
terminal, rendre dans un `OptimizedBuffer` hors écran et envoyer à l'hôte les
cellules changées à chaque frame. L'hôte les copierait par `drawFrameBuffer`. On
supprime ainsi l'aller-retour « rendu en VT, puis re-parsing » et on garde les
attributs OpenTUI (liens, graphèmes). Les entrées remonteraient en `KeyEvent`
structurés.

`v2-estimate.ts` rejoue chaque flux dans l'émulateur et compare le buffer composé
après chaque « frame ». Deux granularités : chaque lecture PTY de 4 Kio (pire
cas), ou 64 Kio coalescés, ce que fait un hôte à 60 Hz sous charge. Coût par
cellule changée : 28 octets bruts (format mémoire OpenTUI + index), ou 11 octets
compacts (index u16, UTF-8, 2×RGB24, attributs).

| Flux (120×40) | octets VT | diffs compacts, frames de 4 Kio | diffs compacts, frames de 64 Kio |
| ------------- | --------- | ------------------------------- | -------------------------------- |
| seq           | 1,49 Mo   | 0,62 Mo (0,42×)                 | 0,09 Mo (0,06×)                  |
| ls --color    | 128 Ko    | 582 Ko (4,5×)                   | 75 Ko (0,59×)                    |
| vim           | 547 Ko    | 1,13 Mo (2,1×)                  | 236 Ko (0,43×)                   |
| log ANSI      | 3,49 Mo   | 30,6 Mo (8,8×)                  | 1,99 Mo (0,57×)                  |

Conclusion : les diffs de cellules ne gagnent que **coalescés au rythme des
frames**. L'enfant rend de toute façon au plus 60 fois par seconde : il n'enverra
jamais les états intermédiaires qu'un flux VT doit transporter. On gagne alors
×1,7 à ×16. À grain fin, un défilement réécrit chaque cellule, et les diffs coûtent
jusqu'à 9 fois le flux VT. Il faudrait donc un opcode de défilement, comme le
`CSI S` d'un terminal, pour ne pas perdre sur les sorties qui défilent.

La v1 (flux VT) reste le bon choix de départ : elle marche pour n'importe quel
programme, avec un coût mesuré acceptable. La v2 n'est qu'une optimisation entre
apps luciole ; elle demande un protocole versionné et des tests de fidélité par
rapport au rendu direct.

## Limites

- Les tests pilotent le widget par les mocks OpenTUI (protocole clavier legacy)
  et, pour la démo, par un PTY imbriqué. Aucun test n'a eu lieu dans chaque
  émulateur de terminal réel (Ghostty, iTerm2, kitty, Terminal.app).
- Les débits dépendent des flux choisis. La mémoire est un delta de RSS et de tas
  sur 10 instances : un ordre de grandeur, pas une empreinte exacte.
- OSC 8 n'est ni composé ni comblé. Le défilement arrière (scrollback) à la
  molette n'est pas testé, bien qu'OpenTUI le gère quand le programme ne
  demande pas la souris.
- `gaps.ts` observe le flux de sortie en parallèle de l'émulateur. Une requête
  dans une chaîne DCS/OSC d'un autre usage pourrait être répondue à tort. C'est
  acceptable pour une sonde ; le correctif doit se faire dans OpenTUI.
