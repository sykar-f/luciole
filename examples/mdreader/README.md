# mdreader : lecteur Markdown

Lit un fichier `.md` unique ou tous les `.md` d'un dossier (récursif, sans
`node_modules` ni `.git`) : la liste à gauche, le document rendu à droite. Les fichiers
sont lus côté Server ; le rendu est celui de `<markdown>` d'OpenTUI (marked +
tree-sitter). Titres, emphase, listes et cases à cocher, citations, blocs de code
colorés, tableaux et liens : aucun parseur n'est écrit ici.

```sh
bun packages/luciole/src/cli.ts dev --app examples/mdreader                        # dossier courant
MD_PATH=docs bun packages/luciole/src/cli.ts dev --app examples/mdreader           # un dossier
MD_PATH=README.md bun packages/luciole/src/cli.ts dev --app examples/mdreader      # un seul fichier
```

`MD_PATH` est résolu par le Server, depuis son répertoire courant. `/` affiche
`README.md`, sinon `index.md`, sinon le premier document. Un fichier modifié, ajouté ou
supprimé sur le disque recharge la liste et le document ouvert, qui garde sa position.

OpenTUI dessine la prose comme du source coloré : un paragraphe garde les retours à la
ligne du fichier. `server/reflow.ts` rejoint donc les retours souples des paragraphes et
des listes (avec le lexer `marked` qu'utilise OpenTUI), pour que le texte se replie à la
largeur du panneau ; les retours durs (deux espaces, `\`) restent.

## Clavier

Comme un visualiseur à deux panneaux, l'un des deux a les touches. Au lancement, c'est
la liste : les flèches y choisissent un document, qui s'ouvre dès qu'elles s'arrêtent,
en remplaçant l'entrée d'historique (`u` ramène là où le parcours a commencé). Entrée
donne les touches au document, Tab ou `h` les rend à la liste ; un clic donne les touches
au panneau cliqué. La sélection est vive quand la liste a les touches, atténuée sinon.

| Liste (bordure accentuée) | Action                                         |
| ------------------------- | ---------------------------------------------- |
| `j` `k`, `↓` `↑`          | Document suivant / précédent, ouvert à l'arrêt |
| `g`, `Home` / `G`, `End`  | Premier / dernier document                     |
| Entrée, `→`, `l`, Tab     | Lire le document                               |

| Document                     | Action                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| `j` `k`, `↓` `↑`, molette    | Défiler d'une ligne                                                                        |
| Espace, `PgDn` / `b`, `PgUp` | Page suivante / précédente                                                                 |
| `d`, `Ctrl+D` / `Ctrl+U`     | Demi-page                                                                                  |
| `g`, `Home` / `G`, `End`     | Début / fin                                                                                |
| `}` / `{`                    | Titre suivant / précédent                                                                  |
| `t`                          | Plan du document : `j` `k` y déplacent la lecture, Entrée garde la position, Échap revient |
| Tab, `h`, `←`                | Revenir à la liste                                                                         |

| Partout                  | Action                                                           |
| ------------------------ | ---------------------------------------------------------------- |
| `]` / `[` (ou `J` / `K`) | Document suivant / précédent (préchargés), sans changer de focus |
| `/`                      | Chercher un document par nom ou chemin ; `↑` `↓`, Entrée, Échap  |
| `u`                      | Retour dans l'historique                                         |
| `?`                      | Tous les raccourcis actifs                                       |
| `Ctrl+R`                 | Recharger (et relancer la surveillance si elle s'est arrêtée)    |
| `Ctrl+C`                 | Quitter                                                          |

Le texte est une colonne de lecture de 92 caractères au plus, centrée dans le panneau
comme sur le web. Avec un seul fichier (`MD_PATH=fichier.md`), il n'y a ni liste ni
recherche : le document prend tout l'écran et garde les touches. Sous 96 colonnes, la
liste n'apparaît que lorsqu'elle a les touches (parcours, recherche). La ligne d'état
indique la section lue (`§`) et la position (`Top`, `Bot`, `All` ou un pourcentage),
comme un pager.

## Organisation

- `server/library.ts` : résolution de `MD_PATH`, parcours, lecture validée (un chemin
  venu du Client doit désigner un `.md` sous la racine), surveillance `fs.watch`.
- `server/reflow.ts` : retours à la ligne souples rejoints avant l'envoi au Client.
- `actions/library.ts` : `listDocs()` pour la liste, `watchLibrary()` en live.
- `app/layout.tsx` → `components/Library.tsx` : chrome persistant (liste, recherche,
  préchargement des voisins, surveillance). Seul le panneau du document attend le Server.
- `app/page.tsx`, `app/doc/[...path]/page.tsx` : le document, rendu par
  `components/Reader.tsx` (défilement, plan, position mémorisée par document).
- `app/loading.tsx`, `not-found.tsx`, `error.tsx` : même cadre (`components/frames.tsx`).

Vérification : `bun run test:pty:mdreader` (`scripts/pty/mdreader.ts`) construit
l'application et parcourt une bibliothèque temporaire dans un vrai PTY.

## Limites

- Coloration du code : OpenTUI 0.5.12 n'embarque que les grammaires JavaScript,
  TypeScript, Markdown et Zig ; les autres langages s'affichent sans couleur.
- Le plan et `{` `}` ne connaissent que les titres de premier niveau du document (pas
  ceux d'une liste ou d'une citation). Leur position vient de l'état interne de
  `MarkdownRenderable` (`_parseState`, `_blockStates`, typés publics mais préfixés) :
  à revérifier à chaque mise à jour d'OpenTUI.
- Les liens sont affichés (texte souligné, URL entre parenthèses) mais pas suivis, y
  compris vers un autre `.md` de la bibliothèque.
- Au plus 2 000 documents et 16 niveaux ; un fichier de plus de 2 Mio est tronqué ; un
  lien symbolique vers un dossier n'est pas suivi.
- La surveillance utilise `fs.watch` récursif (vérifiée sous macOS seulement). Rien ne
  se reconnecte seul : après une coupure, `Ctrl+R` la relance.
- La position de lecture par document vit en mémoire du Client : perdue en quittant.
- Les citations ne sont pas reformatées, ni une liste qui contient un bloc de code.
- `marked` (17.0.1) est importé côté Server sans être déclaré dans `package.json` : c'est
  une dépendance d'`@opentui/core`, installée avec elle. À déclarer si l'exemple reste.

## Note pour le framework

Une Server Function live **silencieuse** ne voit pas son Client partir : le runtime ne
constate la fermeture de la connexion qu'en écrivant. Sans écriture, Flight n'appelle
jamais `throw()` sur l'itérateur, et le `finally` d'un `async function*` (ou la
fermeture d'un watcher) n'a pas lieu, ni après `Ctrl+C` ni après un kill du Client
(vérifié en instrumentant la fermeture). API.md dit pourtant que le Server arrête le
générateur au démontage. Contournement ici : `libraryChanges()` renvoie toutes les
10 s la version courante (que le Client ignore), et c'est un itérateur écrit à la main,
car un `async function*` en attente d'un événement ne traiterait `throw()` qu'après cet
événement. Le framework pourrait relier l'abandon de la requête (`req.signal`) au
`signal` de `renderToReadableStream`.
