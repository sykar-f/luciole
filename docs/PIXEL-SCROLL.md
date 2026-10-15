# Défilement au pixel : contrat expérimental app–hôte, version 1

Ce document définit les octets et leur sens pour le contrôleur applicatif et
l'hôte xterm. Le codec interne est
[`packages/core/src/pixel-scroll/protocol.ts`](../packages/core/src/pixel-scroll/protocol.ts).
Il n'est pas exporté par `@luciole-sh/core`. Ce contrat et son codec n'activent
aucun comportement à eux seuls ; les intégrations app et hôte sont distinctes.

L'application possède la position logique `p = n + f`, en lignes de contenu,
avec `n = floor(p)` et `0 ≤ f < 1`. L'hôte possède les métriques, le DPR et la
quantification au pixel physique. Il n'ajoute ni inertie ni animation. La phase
transportée est une fraction de ligne, **jamais une quantité de pixels**.

## Transport et numéros expérimentaux

Une opération et un rapport utilisent exactement la même enveloppe :

```text
ESC ] 19462 ; luciole-pixel ; {JSON avec "op" et "version":1} ESC \
```

`ESC` vaut `0x1b`, `ST` vaut les deux octets `ESC \`. L'encodeur produit ST ; le
décodeur accepte aussi BEL (`0x07`) comme terminaison. Pas de formes C1 sur 8 bits.
Le JSON et le préfixe sont ASCII imprimables, sans saut de ligne ; les nombres
sont finis, sans conversion implicite depuis des chaînes. Chaque objet a
exactement les champs décrits, sans champ supplémentaire. L'ordre des clés JSON
n'importe pas. La version entière `1` est obligatoire **dans chaque message**,
y compris les entrées. Une autre version, même dans une enveloppe connue, est
ignorée ; elle ne déclenche aucune activation.

Le mode DEC privé **19463** active (`CSI ? 19463 h`) ou désactive
(`CSI ? 19463 l`) les rapports précis de cette version. Il est désactivé au
démarrage. Les commandes CSI ne transportent pas de JSON : leur association à
la version 1 est définie par cette négociation, pas par le nom du terminal.
Le mode 2026 reste celui de la sortie synchronisée, sans nouvelle signification.
Toutes les opérations app → hôte, y compris `query` et `release`, passent dans
une enveloppe 2026. Les rapports vers stdin sont des OSC seules, sans enveloppe
2026 sur le flux d'entrée.

**19462 et 19463 ne sont pas des allocations.** Ce sont des choix expérimentaux
sans usage connu dans les sources suivantes, vérifiées le 15 octobre 2026 :

| Terminal | Sources consultées pour OSC et modes privés                                                                                                                                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| xterm    | [ctlseqs](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html)                                                                                                                                                                                                  |
| kitty    | [Extensions](https://sw.kovidgoyal.net/kitty/protocol-extensions/), [parseur VT](https://github.com/kovidgoyal/kitty/blob/master/kitty/vt-parser.c), [modes](https://github.com/kovidgoyal/kitty/blob/master/kitty/modes.h)                                         |
| Ghostty  | [OSC](https://github.com/ghostty-org/ghostty/blob/main/src/terminal/osc.zig), [modes](https://github.com/ghostty-org/ghostty/blob/main/src/terminal/modes.zig)                                                                                                      |
| WezTerm  | [Séquences reconnues](https://wezterm.org/escape-sequences.html)                                                                                                                                                                                                    |
| iTerm2   | [Extensions](https://iterm2.com/documentation-escape-codes.html), [parseur OSC](https://github.com/gnachman/iTerm2/blob/master/sources/VT100/VT100XtermParser.m), [modes du terminal](https://github.com/gnachman/iTerm2/blob/master/sources/VT100/VT100Terminal.m) |
| foot     | [foot-ctlseqs](https://codeberg.org/dnkl/foot/src/branch/master/doc/foot-ctlseqs.7.scd)                                                                                                                                                                             |

Ce contrôle ne prouve pas une disponibilité universelle. Le spike employait
OSC 777 et le mode 7727 ; ils ne sont pas repris. OSC 777 sert notamment aux
notifications rxvt-unicode, reconnues par
[foot](https://codeberg.org/dnkl/foot/src/branch/master/doc/foot-ctlseqs.7.scd) et
[Ghostty](https://github.com/ghostty-org/ghostty/blob/main/src/terminal/osc.zig).
Après accord avec un mainteneur de terminal, les numéros, l'enveloppe ou les
champs pourront changer dans une nouvelle version. Il faudra modifier le codec
commun et négocier cette version explicitement ; aucune compatibilité binaire
avec le spike, kitty ou une future norme n'est promise. Ne pas envoyer les deux
protocoles à l'aveugle.

## Champs, unités et limites

Les limites sont celles du fil, pas une promesse de capacité GPU :

- `generation` : entier de 1 à `Number.MAX_SAFE_INTEGER`, croissant strictement
  à chaque `begin`, jamais réutilisé durant la session terminal, même après
  libération ou renégociation. À épuisement, rester en mode ordinaire.
- `id` : entier de 1 à 65535, identifiant local d'une surface. La version 1
  n'autorise **qu'une surface active ou en préparation à la fois**. Changer de
  surface exige d'abord une libération canonique ; réutiliser un id exige une
  nouvelle génération.
- `rect = {x,y,width,height}` : coordonnées et dimensions entières en cellules.
  Origine `(0,0)` en haut à gauche de la grille visible ; axes vers la droite et
  le bas. `x,y ≥ 0`, `width,height ≥ 1`, et les deux bords exclusifs sont au plus 65535. L'hôte vérifie aussi les dimensions réelles de sa grille et refuse un
  rectangle hors grille, sans le rogner silencieusement.
- `origin` : entier de contenu entre 0 et `Number.MAX_SAFE_INTEGER`. Une passe
  future à `origin+1` doit rester représentable ; l'app vérifie cette condition.
- `fraction` : phase logique absolue dans `[0,1[`. Pas un delta accumulé.
- `phase` : phase **présentée et quantifiée**, dans `[0,1]`. Pour une hauteur
  physique de cellule entière `H > 0`, l'hôte emploie
  `q = floor(f × H + 0.5)` puis `phase = q/H`. L'arrondi peut donner 0 ou 1
  pour une fraction logique strictement comprise entre les deux. Cela ne change
  ni `origin`, ni la position logique publique.
- `x,y` des entrées : coordonnées fractionnaires en cellules, origine 0 dans
  la grille visible entière, avant inversion de la translation. Elles sont
  dans `[0,65535[` ; l'hôte vérifie aussi `[0,colonnes[ × [0,lignes[`.
- `dx,dy` : deltas signés en colonnes/lignes, dans `[-65535,65535]`. Un `dy`
  positif avance vers le bas du contenu ; `dx` positif va vers la droite.
  L'extension de rendu ne défile que verticalement dans cette version.
- `nonce` : 1 à 64 caractères parmi `A–Z a–z 0–9 _ -`, choisi neuf par l'app
  pour chaque requête. Il corrèle les réponses ; ce n'est pas une authentification.
- `modifiers` : masque entier 0 à 15, Shift=1, Alt=2, Ctrl=4, Meta=8.

Le payload OSC (`luciole-pixel;` et JSON, sans numéro ni délimiteurs) est limité
à 4096 caractères ASCII. `decode` accepte une seule séquence complète ;
`decodePayload` accepte le payload transmis par le hook OSC 19462 de xterm.
Ils retournent `undefined` sans exception pour une entrée mal formée, hors
limites, de version inconnue ou d'opération inconnue. Le parseur ANSI appelant
réassemble les fragments du transport, borne son tampon et conserve les autres
entrées ordinaires. Il ne doit pas appeler `decode` séparément sur chaque chunk
PTY. `encode` lève `TypeError` pour des données locales invalides.

Le codec est sans état : il ne vérifie ni l'ordre des opérations, ni les dimensions
réelles, ni la disponibilité d'une génération. Ces contrôles appartiennent aux
deux consommateurs. Un message reconnu mais invalide pendant une transaction
invalide celle-ci ; il ne faut pas simplement omettre son `step` puis accepter
un commit incomplet. Une OSC étrangère reste du ressort de son propre handler.

## Opérations app → hôte

Toutes ont les champs communs `{op,version:1}` :

| `op`       | Autres champs obligatoires  | Sens                                                                                 |
| ---------- | --------------------------- | ------------------------------------------------------------------------------------ |
| `query`    | `nonce`                     | Demander les capacités sans attendre ; ne modifie pas la grille.                     |
| `begin`    | `generation`                | Ouvrir une préparation distincte de l'actif.                                         |
| `register` | `id,generation,rect,origin` | Capturer le rectangle au checkpoint exact du parseur, après ses cellules à `origin`. |
| `step`     | `id,generation,fraction`    | Fixer la phase absolue de cette préparation. Même zéro est explicite.                |
| `commit`   | `generation`                | Valider snapshot, bord entrant, rectangle, origine et phase avec la frame.           |
| `release`  | `id,generation`             | Libérer la génération canonique correspondante, jamais une préparation arbitraire.   |

Après découverte, chaque frame fractionnaire suit cet ordre, sur **le même flux
ANSI que ses cellules**, dans une seule enveloppe synchronisée :

```text
CSI ? 2026 h
  begin(g)
  cellules de la grille à l'origine n, chrome suivant p
  register(id,g,rect,origin=n)
  cellules projetées à n+1 si f>0, sans déplacer le chrome
  step(id,g,fraction=f)
  commit(g)
CSI ? 2026 l
```

Pour `f=0`, aucune passe future n'est nécessaire. Pour `f>0`, le snapshot de
hauteur `h` est translaté vers le haut de `q` pixels physiques et clippé à `rect`.
Le bord inférieur entrant vient de la dernière ligne de la grille projetée à
`n+1`, translatée vers le bas de `H-q`. Il est capturé **au commit** et conservé
avec le snapshot ; les redraws ultérieurs ne le remplacent pas par une ligne
arbitraire de la grille courante. Un saut de plusieurs lignes réenregistre à
la nouvelle origine entière, sans demander au snapshot d'inventer des pages.

Cette version exige un `register` et un `step` par `begin`, puis un seul commit
correspondant ; la réutilisation d'un snapshot par `step` seul est réservée à une
évolution. Duplicats, mauvais id, mauvaise génération ou opération hors ordre
refusent toute la préparation et conservent l'actif. Un nouveau `begin` abandonne
une préparation incomplète sans écraser la dernière présentation validée. Les
cellules et le chrome de la frame ne sont publiés qu'avec un commit complet.
Les enveloppes 2026 ne s'empilent pas : l'encodeur de frame retire les enveloppes
internes avant de produire la paire extérieure.

Un timeout 2026, une séquence tronquée ou un commit refusé ne constituent jamais
un commit implicite. L'hôte conserve la dernière présentation complète, y
compris son bord entrant et ses métadonnées ; si les cellules/chromes ont changé,
il doit aussi conserver leur frame validée pour ne pas exposer une moitié de
transaction. S'il ne peut garantir cette atomicité (notamment rectangle déplacé),
il doit refuser la capacité plutôt qu'afficher une préparation partielle.

## Générations parsées, validées et présentées

Une génération **parsée** est celle dont les commandes arrivent : ses captures
restent hors écran. Une génération **validée** a passé un commit complet ; elle
peut attendre son rendu. Une génération **présentée** est celle dont le rendu
est effectivement publié par l'hôte. L'envoi de `commit` n'est pas un acquittement
de présentation. Plusieurs commits peuvent être regroupés avant un rendu ; seul
celui effectivement affiché devient la référence des entrées.

Le snapshot actif et la préparation sont distincts. Un `begin(g+1)` reçu après
`commit(g)` mais avant son rendu ne détruit ni `g`, ni ses métadonnées prêtes à
présenter. La génération des entrées, le rectangle, l'origine et la phase
quantifiée sont publiés ensemble lors du rendu, jamais lors de `register`.

L'app conserve les géométries/hit maps du snapshot à `n` et de la passe à `n+1`
par génération, dans une rétention bornée. Une entrée d'une ancienne génération
encore retenue utilise cette géométrie, même si l'app prépare déjà la suivante.
Une génération expirée, une cible détruite ou un id non reconnu fait rejeter
l'entrée : ne pas la réinterpréter dans la grille la plus récente. Les ancres
de sélection/drag restent des positions stables du contenu, pas des cellules
de la projection courante. Aucun rapport ne vaut acquittement des générations
qui le précèdent ; cette version ne fournit pas de message d'acquittement dédié.

## Rapports hôte → app, par stdin

Le chemin est `onData` vers stdin, ou le même retour via le PTY. Pas d'appel JS
parallèle à l'application. Tous les rapports ont `{op,version:1}` :

| `op`         | Autres champs obligatoires                                | Sens                                                     |
| ------------ | --------------------------------------------------------- | -------------------------------------------------------- |
| `capability` | `nonce,snapshot,precise,reason`                           | Réponse à la requête, ou révocation du même nonce.       |
| `wheel`      | `id,generation,x,y,phase,modifiers,dx,dy,source`          | Geste normalisé ; `source` vaut `precise` ou `discrete`. |
| `pointer`    | `id,generation,x,y,phase,modifiers,action,button,buttons` | `action` vaut `move`, `down`, `up` ou `drag`.            |

Pour `capability`, `reason=ready` exige `snapshot=true` et `precise=true`.
Toute autre raison exige les deux booléens faux : `reduced-motion`,
`screen-reader`, `no-gpu`, `disabled`, `invalidated`. Un hôte qui ne sait pas
fournir ensemble snapshots et entrées précises refuse cette version.

`button` suit les indices DOM : 0 principal, 1 auxiliaire, 2 secondaire,
3 arrière, 4 avant. `buttons` est le masque des boutons tenus **après**
l'événement : principal=1, secondaire=2, auxiliaire=4, arrière=8, avant=16.
Un `down` contient le bit du bouton changé ; un `up` l'a retiré.
Pour `move`, `button=-1` et `buttons=0` ; pour `drag`, `button=-1` et
`buttons>0`. Le drag reste attaché à sa surface capturée jusqu'au `up` ;
ses coordonnées peuvent sortir de `rect`, en restant dans la grille visible.
Les rapports hors fenêtre, le tactile et les boutons supplémentaires sont hors
version 1. Aucun rapport n'est émis sans présentation correspondante valide.

La molette et le pointeur nomment toujours la **génération présentée**, même
lorsqu'un nouveau `begin` est déjà arrivé. Pour le hit test intérieur,
`u = y - rect.y + phase` donne la ligne de contenu relative à `origin`.
Si `u < rect.height`, utiliser la hit map du snapshot ; sinon utiliser celle de
la passe future à `origin+1`, avec coordonnée locale `u-1`. Les deux cartes
conservent aussi les géométries horizontales de leur passe. Le test utilise la
phase quantifiée du rapport, pas `fraction` ; deux positions dans une même
cellule terminal peuvent désigner des contenus différents. Le drag capturé
hors rectangle relève du routage et de l'auto-scroll de l'app.

L'hôte convertit les deltas DOM pixels avec les dimensions CSS réelles des
cellules ; les modes ligne/page sont convertis en unités de grille. Il fragmente
un delta dépassant la limite du fil en plusieurs rapports de même présentation,
sans le tronquer. `precise` signifie suivi direct ; `discrete` décrit un geste
explicitement en lignes/pages. Le mode DOM pixels ne prouve pas qu'il s'agit
d'un trackpad. Aucune étiquette de momentum n'est inventée et aucun ressort
supplémentaire n'est appliqué par l'hôte. Une interpolation de gestes discrets,
si l'app en propose une, appartient à l'app et cède devant un geste précis.
Un geste consommé par ces rapports ne produit pas en plus un événement SGR.

## Découverte, repli et invalidation

L'app commence en défilement ordinaire par lignes, envoie `query` avec un nonce
neuf et continue **sans attente bloquante**. Une réponse de version connue,
nonce courant et `reason=ready` autorise l'activation du mode 19463 et les
transactions. Aucun nom de terminal, variable d'environnement ou présence du
module JS ne remplace ce dialogue. Un terminal ordinaire ignore l'OSC inconnue,
ne reçoit ni mode 19463 activé ni projections, ne montre aucun texte nouveau
et garde son chemin de défilement par lignes.

Le mode est nécessaire pour `wheel` et `pointer`, pas pour la réponse de capacité.
Il ne change pas les modes clavier/collage. Hors surface, les entrées ordinaires
restent ordinaires. Sa désactivation arrête les rapports précis ; elle ne libère
pas implicitement un snapshot fractionnaire.

L'hôte refuse si la réduction des mouvements est demandée, si le mode lecteur
d'écran est actif, si le GPU nécessaire est indisponible, ou si l'utilisateur
a désactivé la fonction. À changement de préférence ou perte de contexte, il
révoque la capacité avec le dernier nonce, coupe les rapports et invalide les
ressources concernées. Une réponse d'un nonce périmé ne réactive jamais l'app.
Une révocation est terminale pour ce nonce : une nouvelle activation demande
une nouvelle requête et une réponse `ready` correspondante.

Une libération normale exige une **grille canonique** : phase logique exactement
zéro, grille à l'origine enregistrée, dernier commit valide et aucune peinture
non validée depuis. Une fraction positive arrondie à zéro ne suffit pas. L'app
émet d'abord une transaction complète à `fraction=0`, puis `release(id,g)` dans
la même enveloppe, après `commit(g)`, ou dans une enveloppe ultérieure sans
nouvelle peinture. L'hôte peut alors publier atomiquement la grille canonique et
la suppression de la surface. Un release périmé ou non canonique est refusé ;
l'actif reste composé jusqu'à une demande valide. La sélection native,
un transfert vers une autre région ou une popup intersectée doivent passer par
ce chemin canonique avant de remettre les gestes à la grille ordinaire.

Pour la sélection native, le déclencheur sur le fil est un rapport `pointer`
avec `action=down` et ses `modifiers`. Lorsque le mode précis est actif et qu'une
présentation fractionnaire est active, l'hôte consomme un down dans la surface
portant son modificateur de sélection native : Shift sur xterm.js, ou Option
sur macOS lorsque l'hôte force la sélection avec cette touche. Il ne transmet
pas ce down à xterm.js ; il émet le rapport avec la génération et la phase
présentées, Shift=1 ou Option/Alt=2 dans le masque. Une fraction logique positive
arrondie à zéro reste fractionnaire pour cette décision.

L'app termine alors la fraction et émet la transaction canonique suivie de
`release` décrite ci-dessus (règle 5). Pour ne pas dépendre d'une configuration
locale de l'hôte absente du fil, le contrôleur demande ce retour canonique pour
tout down avec Shift ou Alt dans une surface fractionnaire ; seul l'hôte décide
si ce geste relève de sa sélection native.

Pour un geste natif ainsi intercepté, l'hôte retient le down initial et les
mouvements suivants, ainsi que le up s'il arrive entre-temps, sans les remettre
à sa sélection native ni les dupliquer en rapports applicatifs. **Après la
présentation effective de la libération canonique**, et non au parsing de
`commit` ou de `release`, il rejoue le down puis les événements retenus, dans
l'ordre, à sa sélection native sur cette grille. Si la présentation est
invalidée avant ce passage, il annule le geste retenu sans le rejouer sur une
autre grille. Sans fraction active, la sélection native garde son comportement
habituel, sans cette interception ni ce retour canonique préalable.

Reset du terminal, changement de buffer, resize, changement de police/zoom/DPR
et perte de contexte annulent préparation, présentations et hit maps ; le mode
précis revient à zéro. L'hôte révoque la capacité avec `invalidated` (ou `no-gpu`
si le GPU est perdu), puis attend une nouvelle découverte. L'app conserve sa
position logique, repeint une grille entière canonique avec les nouvelles
métriques et recommence avec une génération neuve. La révocation ne peut pas
réparer seule une grille future déjà parsée : le retour ordinaire attend ce
redraw canonique. En cas de perte GPU, aucun vieux snapshot n'est réutilisé avec
un autre contexte. La destruction libère toutes les ressources sans rapport.

## Les cinq règles de présentation

1. L'app possède la position logique ; l'hôte possède métriques, DPR et
   quantification. Un déplacement de zéro pixel est une composition valide,
   jamais une raison d'afficher la grille future brute.
2. Le rectangle contient seulement le contenu. Barre de défilement, bordure et
   chrome fixe restent hors de la translation ; leur géométrie suit `p`.
3. Snapshot, bord entrant, phase, rectangle et génération forment une seule
   présentation validée. Une capture en préparation ne remplace pas l'actif.
4. Toute entrée désigne la présentation effective, même après l'arrivée d'un
   autre `begin`. Métadonnées parsées et présentées ne partagent pas un simple
   état « pending » mutable.
5. Chaque redraw, même partiel ou déclenché par le curseur, recompose l'actif.
   À phase logique zéro, les mises à jour canoniques de même origine doivent
   aussi renouveler le snapshot validé. Une libération exige une grille
   canonique ; reset, resize et perte de contexte appliquent l'invalidation
   décrite ci-dessus.

## Référence amont et limites

Le [modèle de snapshot proposé par Kovid Goyal dans kitty #9965](https://github.com/kovidgoyal/kitty/discussions/9965#discussioncomment-16812953)
est la référence : enregistrer une aire rectangulaire, en conserver une capture,
mettre à jour la grille sous-jacente, puis composer le déplacement avec un clip.
Ici `register` est le checkpoint de capture ; la passe à `n+1` fournit le bord
entrant ; `step` fixe la translation, `commit` la valide et `release` rend la
main à la grille canonique. La phase en lignes confie la conversion physique à
l'hôte. Les générations et le mode d'entrée précisent la correspondance entre
le rendu et les gestes. Il s'agit d'une interprétation interne de cette idée,
pas d'un protocole adopté par kitty ni de groupes persistants de cellules.

Plusieurs régions simultanées (disjointes ou imbriquées), images sur d'autres
couches, terminaux natifs et hôte desktop sont hors périmètre actuel. Une région
contenant des images non composées dans le même snapshot doit être refusée.
Le transport en bande reste compatible avec un PTY futur, sans certifier ces
intégrations. Les formes non rectangulaires, l'occlusion arbitraire, le scroll
horizontal graphique et les garanties de performance ne sont pas spécifiés.
La fraction peut rester au repos ; ce contrat n'impose ni délai ni animation
de recalage, sauf le retour canonique nécessaire à la libération.
