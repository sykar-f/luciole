# Files — explorateur de fichiers

Un explorateur de fichiers dans le terminal : arborescence navigable, filtre, panneau de
détails et aperçu de l'élément sélectionné (code avec numéros de ligne, images, contenu
d'un dossier, hex dump d'un binaire). Le système de fichiers est lu par le Server ; le
Client ne reçoit que des chemins relatifs à la racine.

```sh
bun packages/airtty/src/cli.ts dev --app examples/files                     # racine : répertoire courant
FILES_ROOT=~/Pictures bun packages/airtty/src/cli.ts dev --app examples/files
AIRTTY_LATENCY_MS=500 bun packages/airtty/src/cli.ts dev --app examples/files  # même parcours à 500 ms de RTT
```

## Clavier

| Touche                      | Action                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `j` `k` `↑` `↓`             | Sélection (`g` / `G` début / fin, `PgUp` / `PgDn` par dix)                                |
| `Entrée` `→` `l`            | Ouvrir le dossier ; sur un fichier, zoomer l'aperçu plein écran                           |
| `Backspace` `←` `h`         | Dossier parent, l'élément d'où l'on vient reste sélectionné                               |
| `/`                         | Filtrer le dossier (`Entrée` garde le filtre, `Échap` l'efface)                           |
| `.`                         | Afficher / masquer les dotfiles                                                           |
| `s`                         | Trier par nom, taille, date de modification                                               |
| `Shift+J` `Shift+K`         | Faire défiler l'aperçu (zoomé : `j` `k` `Espace` `g` `G`)                                 |
| `p`                         | Protocole image : `auto` → `kitty` → `blocks` (demi-blocs)                                |
| _déposer un fichier_        | Glisser un fichier sur le terminal : il est rangé dans le dossier affiché                 |
| `u` / `~`                   | Retour dans l'historique / racine                                                         |
| `?`                         | Liste complète des raccourcis actifs                                                      |
| clic droit / `m`            | Menu contextuel de l'élément : ouvrir, copier nom / chemin / chemin absolu, dotfiles, tri |
| `Ctrl+R`, `Échap`, `Ctrl+C` | Rafraîchir, annuler une navigation, quitter                                               |

L'aide en bas de l'écran est générée depuis les raccourcis actifs, comme dans Forge. La
souris sélectionne une ligne ; un second clic l'ouvre ; le clic droit ouvre son menu contextuel.

## Ce qui se passe où

- **Ouvrir un dossier est une navigation** (`/?dir=src/flight`) : entrée d'historique,
  `loading.tsx` au même gabarit que la page, Échap annule, `not-found.tsx` si le dossier
  a disparu. Le dossier sélectionné est préchargé après 150 ms : Entrée l'affiche sans
  attendre.
- **Sélection, filtre, tri, dotfiles et zoom sont locaux** : aucune requête.
- **L'aperçu est une Server Function** (`actions/files.ts`) appelée 60 ms après la
  sélection et annulée si elle change ; les aperçus déjà vus reviennent d'un cache Client
  (32 entrées, clé chemin + date + taille : un fichier modifié est relu après Ctrl+R).
- **Confinement** : le Server résout chaque chemin reçu (`realpath`) et refuse ce qui sort
  de la racine, `..` comme lien symbolique vers l'extérieur. Un tel lien est listé, mais
  l'ouvrir mène à « not found ». Une FIFO ou un périphérique n'est jamais lu.

## Menu contextuel

Clic droit sur une ligne (ou `m` sur la sélection) : ouvrir le dossier ou l'aperçu plein
écran, copier le nom, le chemin depuis la racine ou le chemin absolu (celui du Server),
la cible d'un lien, afficher les dotfiles, changer de tri. Le menu s'ouvre sous le
pointeur et se retourne s'il sortirait de l'écran ; tant qu'il est ouvert il garde le
clavier (flèches ou `j`/`k`, `Entrée`, `Échap`), un clic ailleurs le ferme. La copie passe
par l'outil du système du terminal (`pbcopy`, `wl-copy`, `xclip`, `xsel`), sinon par
OSC 52 à travers le terminal.

## Glisser-déposer

Déposer un ou plusieurs fichiers sur le terminal les range aussitôt dans le dossier
affiché, sans confirmation. Chaque fichier apparaît tout de suite dans la liste, à sa
place de tri, en ligne fantôme (`↓ nom  arriving…`, grisée) et la liste prend le liseré
de focus ; il devient une vraie entrée quand le Server l'a reçu, ou disparaît avec la
raison de l'échec en bas de l'écran. Le clavier reste libre pendant le transfert.

Il n'y a pas d'aperçu **pendant le survol** : un terminal ne reçoit rien tant que le
fichier n'est pas lâché (macOS gère le glisser, Ghostty ne transmet que le résultat).

Le terminal colle en fait le chemin du fichier (Ghostty l'échappe : `My\ File.png`) ;
l'explorateur reconnaît un collage fait de chemins absolus de fichiers existants
(échappés, entre guillemets ou en `file://`) et l'ignore sinon. Pendant le filtre, un
collage reste du texte pour le champ.

- **Server sur la même machine : déplacement.** Le chemin collé est celui de la machine
  du terminal. Le Client envoie l'empreinte du fichier (périphérique, inode, taille, date,
  SHA-256 du premier Mio) ; le Server ne déplace que s'il voit exactement ce fichier.
  Un même chemin sur deux machines ne suffit donc pas.
- **Sinon : copie.** Le Client lit le fichier et en envoie les octets (32 Mio au plus) ;
  l'original reste en place. Un lien symbolique déposé est toujours copié (son contenu) :
  le Server ne le voit pas comme le même fichier.
- **Jamais d'écrasement** : un nom déjà présent est refusé (lien dur ou création
  exclusive, sans fenêtre de course). La liste se rafraîchit (`invalidate()`) et le
  nouveau fichier est sélectionné. Une issue `unknown` (réponse perdue) est signalée,
  jamais rejouée : le fichier a peut-être déjà bougé.
- `FILES_READ_ONLY=1` sur le Server désactive toute écriture. Les dossiers ne se
  déposent pas.

Un Client authentifié peut ainsi déplacer dans la racine un fichier du Server dont il
connaît l'emplacement, les métadonnées et le premier Mio : c'est une démo, pas un
modèle de droits. Avant d'exposer le Server, lancer avec `FILES_READ_ONLY=1`.

## Images

Une image ne voyage jamais entière. Le Client demande la taille en pixels que son
panneau peut afficher ; le Server (dépendance **`sharp`**, libvips) en calcule une
vignette WebP et l'envoie dans la réponse Flight. OpenTUI (`<image>`) la décode et la
dessine :

- **Taille** : en demi-blocs, 4× les cellules du panneau (quelques Ko) ; en kitty, les
  vrais pixels du panneau d'après la résolution du terminal. Jamais agrandie. Si le
  panneau grandit (zoom, terminal agrandi, passage en kitty), la vignette actuelle reste
  affichée et une plus grande est demandée ; une nouvelle sélection l'annule.
- **Sans blocage** : libvips travaille sur ses propres threads (un JPEG est même décodé
  directement à échelle réduite), le Server continue de servir les autres requêtes ; le
  Client ne décode qu'une petite image (< 1 ms).
- **Cache** : en mémoire (32 Mio) et sur disque dans
  `$XDG_CACHE_HOME/airtty-files/thumbnails/` (`~/.cache/…`), clé chemin + taille + date
  du fichier + taille demandée arrondie à 64 px. Deux demandes identiques en cours se
  partagent le travail. Les images voisines de la sélection sont préchargées : descendre
  dans un dossier de photos les affiche depuis le cache.
- Orientation EXIF appliquée ; un GIF animé montre sa première image.

Protocole d'affichage :

- `auto` (défaut) : protocole graphique **kitty** si le terminal répond à la requête de
  capacités d'OpenTUI (Ghostty, kitty, WezTerm…), sinon **demi-blocs `▀` truecolor**
  (deux pixels par cellule). Sous tmux, OpenTUI choisit toujours les demi-blocs.
- `p` force `kitty` ou `blocks` ; `FILES_IMAGE_PROTOCOL=blocks` fixe la valeur au
  lancement du Client. Le pied de l'aperçu indique le protocole réellement utilisé.

**Ghostty dans herdr** : non testé ici. herdr n'est pas reconnu comme multiplexeur par
OpenTUI ; si herdr transmet la requête kitty à Ghostty sans relayer les images, `auto`
choisira kitty et l'aperçu restera vide : passer en demi-blocs avec `p` ou lancer avec
`FILES_IMAGE_PROTOCOL=blocks`.

Mesuré sur des photos 4000×3000 : avant, le Client recevait 3 à 15 Mo et le décodage
bloquait l'interface 30 à 150 ms par image ; avec les vignettes, l'interface réagit en
3 à 20 ms (première sortie après la touche), le Server produit une vignette 800×600 en
~80 ms (≈ 32 Ko) et une vignette de demi-blocs en ~40 ms (< 1 Ko).

## Vérifications

```sh
tsc --noEmit -p examples/files
oxlint --deny-warnings examples/files
oxfmt --check examples/files
bun packages/airtty/src/cli.ts build --app examples/files
python3 scripts/pty-files.py          # pyte requis (scripts/requirements-pty.txt)
```

`scripts/pty-files.py` lance le Server et le Client construits dans un vrai PTY
(140×40, 500 ms de RTT simulé) sur une arborescence de test : filtre, aperçu image en
demi-blocs (plus de 20 paires de couleurs truecolor), commandes kitty émises quand on
force le protocole, texte avec numéros de ligne, ouverture d'un dossier avec écran de
chargement, retour au parent avec sélection conservée, tri, lien symbolique vers un
dossier, dotfiles, hex dump, zoom, menu contextuel au clic droit et au clavier (copie vérifiée
via un faux `pbcopy`), lien cassé, lien hors racine refusé, glisser-déposer
(annulation, déplacement, copie quand le Server ne voit pas le même fichier, refus
d'écraser), restauration du terminal. Vérifié à la main en plus : mode `dev`, décodage PNG/JPEG/GIF/WebP, 80×24
(détails repliés sur une ligne), dossier de 5000 entrées (~15–25 ms par déplacement).

## Limites

- Un dossier liste au plus 5000 entrées (au-delà, un avertissement s'affiche) ; tout est
  rendu d'un coup, sans virtualisation.
- Le texte est prévisualisé sur ses 256 premiers Kio (4000 lignes). La coloration
  syntaxique couvre les grammaires livrées avec OpenTUI (TypeScript, JavaScript/JSON,
  Markdown, Zig) ; les autres fichiers sont affichés en texte brut numéroté.
- Le cache disque des vignettes n'est jamais purgé (quelques Ko à quelques dizaines de
  Ko par image et par taille) : le vider à la main au besoin.
- `sharp` est une dépendance native du Server (ajoutée à `package.json`) : le paquet
  `@img/sharp-<os>-<arch>` doit exister pour la machine du Server.
- La seule écriture est le dépôt d'un fichier : ni renommer, ni supprimer, ni déposer
  un dossier.
- Les touches tapées dans la même milliseconde que `/` peuvent arriver avant que le
  champ de filtre ait le focus (il le prend au rendu suivant).
- `LoadingProps` ne transmet pas la search : `loading.tsx` lit le dossier visé avec
  `useRouterState` (contournement dans l'exemple, pas de changement du framework).
