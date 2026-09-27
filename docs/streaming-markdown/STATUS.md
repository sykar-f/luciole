# Markdown stable en streaming — état

Branche `feat/streaming-markdown` (partie de `main` à `79410fc`), mission décrite dans
`HANDOFF.md`. Rien n'est fusionné dans `main` ni poussé.

## Où en est-on

Tous les critères du §7 du handoff sont remplis :

| Critère                                                             | État                                                                                    |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1. Composant utilisé par le transcript (messages, « thinking »)     | `<Markdown>` d'`airtty/client` (`packages/airtty/src/markdown/`), dans `Transcript.tsx` |
| 2. Banc PTY : 0 oscillation, marqueurs bruts ≤ `top-level`          | 0 oscillation et 0 trame brute, par mots et par 3 caractères (tableau plus bas)         |
| 3. Tests : blocs figés, fermeture optimiste, fini = streamé, parité | `tests/markdown.test.tsx`, `tests/markdown-close.test.ts`                               |
| 4. `verify`, `test:pty:coder`, essai réel `--harness claude`        | verts ; essai réel : 0 oscillation (Claude Code 2.1.283, une réponse)                   |
| 5. `STATUS.md` : décisions, écarts avec Streamdown, mesures         | ce document                                                                             |

Sur décision de l'utilisateur (§8), le composant est promu dans le framework :
`<Markdown>` est exporté par `airtty/client` (documenté dans `docs/API.md`, « Markdown en
streaming ») et `airtty` dépend de `marked` 17.0.1. Il n'utilise que `box`, `text`, `code`
et `markdown` (tableaux) : il reste portable vers la cible web. L'export est un ajout :
`ABI_VERSION` ne change pas (il ne bouge que pour un changement incompatible).

## Architecture

```
packages/airtty/src/markdown/close.ts    fermeture optimiste du bloc en cours (façon remend)
packages/airtty/src/markdown/render.ts   tokens marked → nœuds (texte stylé, code, citation, filet, tableau)
packages/airtty/src/markdown/stream.ts   découpage incrémental en blocs, blocs figés, bloc de queue
packages/airtty/src/markdown/Markdown.tsx  le composant React (box, text, code, markdown pour les tableaux)
```

1. **Découpage** : la réponse est lexée par `marked` 17.0.1 (déjà au catalogue, épinglé dans
   les dépendances d'`airtty`) en blocs de premier niveau. Le lexage est incrémental : les jetons
   dont la source n'a pas changé sont repris, sauf les deux derniers (qui peuvent encore
   fusionner avec la suite : soulignement setext, élément de liste suivant), et seule la
   fin est relexée. `parseMarkdownIncremental` d'OpenTUI fait la même chose ; il n'est pas
   exporté par le paquet, et ses erreurs sur un tableau qui grandit (voir plus bas) ont
   décidé de ne pas en dépendre.
2. **Blocs figés** : tout bloc sauf le dernier est rendu une fois ; ses nœuds gardent leur
   identité tant que sa source ne change pas, et la vue (`memo`) ne le redessine plus.
   Exception volontaire : une définition de lien (`[x]: url`) oblige à tout relexer et
   redessine les blocs qui y renvoient, une fois, quand elle est complète (pas à chaque
   caractère).
3. **Inline synchrone** : titres, gras, italique, code inline, liens, images sont rendus en
   `StyledText` pour un `<text>`, sans Tree-sitter. L'aperçu et le rendu final sont le même
   calcul : ils ne peuvent pas différer.
4. **Bloc de queue** (le dernier, pendant le streaming) : `closeTail` ferme les marqueurs
   ouverts de son dernier contexte inline, puis il est relexé seul. Une ligne non terminée
   faite seulement de syntaxe de bloc (`-`, `##`, ` ``` `, `>`, `---`, `| a | b`) attend son
   saut de ligne ; un paragraphe de lignes `|` (un tableau sans sa ligne de séparation) est
   caché.
5. **Code** : texte brut tant que la clôture n'est pas arrivée, puis `<code>` d'OpenTUI
   (Tree-sitter) une seule fois ; le texte ne bouge pas, seules ses couleurs changent. Une
   ligne de clôture à moitié tapée n'est pas affichée.
6. **Tableaux** : rendus par `<markdown streaming conceal>` d'OpenTUI limité au tableau, qui
   les dessine de façon synchrone (`TextTableRenderable`, sans Tree-sitter) : parité
   gratuite. Les lignes arrivent une à une, seulement quand elles sont terminées.
7. **Fin du streaming** : `streaming` passe à faux, le dernier bloc est rendu sans
   fermeture optimiste ; si rien n'était ouvert, le rendu est identique (testé).

## Streamdown : ce qui est repris, ce qui est écarté

Étudié sur `vercel/streamdown` (`0b6b20d`, 25 septembre 2026) : `packages/streamdown/lib/parse-blocks.tsx`,
`packages/remend/`.

| Idée de Streamdown                                          | Ici                                                                                                                                                                                                                     |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Découpage en blocs par le lexer de `marked`, blocs mémoïsés | **Repris.** Streamdown compare des chaînes et reparse chaque bloc isolément ; ici les jetons du lexage global sont gardés (les références de liens restent résolues).                                                   |
| Réutilisation des blocs stables (`countStableBlocks`)       | **Repris**, simplifié : les jetons inchangés sauf les deux derniers, comme OpenTUI.                                                                                                                                     |
| Relexage complet quand une définition de lien apparaît      | **Repris** (`linkDefinitionPattern`), plus : une définition en cours d'écriture est ignorée.                                                                                                                            |
| `remend` sur tout le texte avant découpage                  | **Adapté** : fermeture sur le seul dernier contexte inline du bloc de queue ; scanner à piles (emphase, code inline, crochets) plutôt que comptages par regex. 54 cas de test, repris des tests de `remend` et adaptés. |
| Liens incomplets : `streamdown:incomplete-link`             | **Écarté** au profit du mode `text-only` : le libellé seul, comme il sera affiché avant ` (url)`. Un `[libellé]` final est traité comme un lien dont la `(` va arriver.                                                 |
| Marqueur ouvert sans contenu (`texte **`)                   | **Ajouté** : retiré plutôt que fermé (Streamdown retire l'espace final).                                                                                                                                                |
| Titres setext incomplets (`setextHeadings`)                 | **Remplacé** par la règle « une ligne de syntaxe seule attend son saut de ligne ».                                                                                                                                      |
| Blocs HTML déséquilibrés fusionnés, maths `$$`, KaTeX       | **Écartés** : pas de HTML ni de maths dans un terminal ; le HTML est affiché tel quel, comme OpenTUI.                                                                                                                   |
| Shiki, contrôles de code, Mermaid, sécurité des liens       | **Écartés** (web). La coloration reste celle d'OpenTUI (Tree-sitter), une fois le bloc fermé. Les liens portent leur URL en OSC 8 (`link` des chunks), comme OpenTUI.                                                   |
| Tableaux progressifs                                        | **Repris**, ligne par ligne terminée.                                                                                                                                                                                   |
| Comparateurs `- > 25`, tilde simple `20~25`                 | Le tilde entre deux caractères de mot n'est jamais un délimiteur ; les comparateurs n'ont pas été nécessaires (`>` n'est pas fermé).                                                                                    |

## Parité avec `<markdown conceal>` (réponse finie)

La cible est le rendu d'OpenTUI 0.5.12 pour une réponse finie (mode `coalesced`, `conceal`) :
les lignes de la source, marqueurs cachés, puces et numéros d'origine en `markup.list`,
repli des lignes longues à la colonne 0 (pas d'indentation suspendue), une ligne vide autour
du code, des citations, des filets et des tableaux, lignes vides de la source conservées
ailleurs. Les couleurs et attributs sont repris chunk par chunk (gras sans couleur propre,
lien : libellé, ` (`, URL, `)`). Le test de parité compare l'écran des deux composants,
caractère par caractère, sur `tests/fixtures/markdown/rich.md`.

Écarts voulus : ce sont des défauts du rendu Tree-sitter, sur des constructions rares, pas
des choix de présentation. Aucun point visible d'une réponse ordinaire ne change.

| Construction                        | `<markdown conceal>`                        | Ici                                     |
| ----------------------------------- | ------------------------------------------- | --------------------------------------- |
| Échappement `\*`                    | barre oblique affichée, en couleur de code  | `*` seul                                |
| Titre ATX fermant `## T ##`         | `T ##`                                      | `T`                                     |
| Lien par référence `[a][r]`         | `a`                                         | `a (url)`, comme un lien en ligne       |
| Code dans un élément de liste       | décalé, et l'élément suivant indenté à tort | indenté sous l'élément                  |
| Citation imbriquée `> > x`          | `│ > x`                                     | `│ │ x`                                 |
| Réponse finie sur un ` ``` ` ouvert | coloré                                      | reste en texte brut (bloc jamais fermé) |

## Mesures

Banc : `bun run test:pty:markdown` (`scripts/pty/markdown-stability.ts`), coder sur le
harness factice, mot-clé `markdown` (12 sections : titres, listes imbriquées, code,
3 tableaux, 2 citations, ~5 400 caractères), 100 × 30, `CODER_FAKE_DELAY_MS=8`, écran
échantillonné toutes les ~5 ms jusqu'à 1 s après la dernière ligne. Oscillation : une ligne
qui passe de A à B et revient à A en moins de 3 échantillons (`bench/oscillations.py`
porté en TS). Trame brute : un `**`, un backtick, un `## `, un `](` ou un `~~` à l'écran
(la réponse finie n'en montre aucun). Le parcours échoue au-delà de 0 et 0.

| Variante (même banc, 27 septembre 2026)                 | Par mots : oscillations | trames brutes | Par 3 caractères : oscillations | trames brutes |
| ------------------------------------------------------- | ----------------------: | ------------: | ------------------------------: | ------------: |
| `<markdown streaming conceal>` (avant tout correctif)   |                     169 |    440 / 1618 |                             413 |   1003 / 3002 |
| `conceal` seulement une fois fini (`main`, `2c82de8`)   |                      87 |   1449 / 1635 |                              80 |   2809 / 2990 |
| `internalBlockMode="top-level"` + `conceal` (référence) |                       0 |     62 / 1626 |                              19 |    282 / 2991 |
| **ce composant**                                        |                   **0** |  **0 / 1613** |                           **0** |  **0 / 2952** |

Les variantes d'OpenTUI ont été mesurées en remplaçant temporairement le composant dans
`Transcript.tsx` (non commité). Sur cette réponse plus riche que celle du handoff, même la
variante `top-level` oscille en découpage fin.

Essai réel : `bun scripts/pty/markdown-stability.ts claude` (Claude Code 2.1.283, une
réponse demandée en Markdown : titre, liste imbriquée, code TS, tableau) : 920 échantillons,
**0 oscillation**. Les 398 trames « brutes » sont toutes du contenu légitime (un littéral de
gabarit TS, un tableau qui cite la syntaxe Markdown dans du code inline).

Tests unitaires (`tests/markdown.test.tsx`) :

- pour **chaque préfixe** de la réponse riche et de `rich.md`, tout bloc sauf le dernier a
  des nœuds identiques (même objet) d'un préfixe à l'autre, et égaux à ceux de la réponse
  finie ;
- streamée par mots puis terminée, la réponse donne exactement les nœuds du rendu fini
  (réponse riche, `rich.md`, `edge.md`) ;
- rendue dans `testRender` par 3 caractères, la hauteur ne diminue jamais, aucun marqueur
  n'apparaît, et l'écran final streamé est celui du rendu fini ;
- parité d'écran avec `<markdown conceal>` ; sélection à la souris (texte sans marqueurs).

Performance : sur une réponse de 27 k caractères (~6 700 jetons) reçue par morceaux de
40 caractères, une mise à jour coûte 0,09 ms en moyenne (p95 0,15 ms, max 2,6 ms), lexage
et construction des nœuds compris.

## Limites connues

- **Largeur des colonnes d'un tableau** : `TextTable` (largeur pleine, répartition
  proportionnelle) recalcule les colonnes à chaque ligne reçue ; les cellules déjà affichées
  peuvent se décaler horizontalement pendant que le tableau s'écrit (vu en réel). Pas
  d'oscillation, la hauteur ne fait que croître. Alternatives : n'afficher le tableau
  qu'une fois complet (saut de hauteur d'un coup), ou figer les largeurs sur les premières
  lignes (colonnes mal réparties ensuite).
- **Heuristiques de fermeture** : un `*` ou un `_` ouvert en fin de texte est fermé s'il
  peut ouvrir selon les règles de flanc de CommonMark (simplifiées) ; `[x` en fin de texte
  est affiché sans son crochet le temps d'une trame. Le rendu final (sans heuristique)
  corrige tout cas mal deviné.
- Une définition de lien qui arrive après ses références redessine ces blocs une fois.
- Repli des lignes longues d'un élément de liste à la colonne 0, comme `<markdown conceal>`
  (parité) : `top-level` fait une indentation suspendue.

## Décisions de l'utilisateur

- **Promotion** dans `packages/airtty` : acceptée (27 septembre 2026), voir plus haut.
- **Tableaux** : l'affichage progressif est gardé.

## À décider (utilisateur)

- **Titres** : OpenTUI 0.5.12 ne leur applique pas `markup.heading` (ils sortent en
  couleur de texte, sans gras) ; la parité garde ce rendu. Les colorer serait un
  changement visible.

## Reproduire

```sh
bun test tests/markdown.test.tsx tests/markdown-close.test.ts
bun run test:pty:markdown                              # banc, harness factice
bun scripts/pty/markdown-stability.ts claude            # une réponse réelle (quota)
MARKDOWN_FRAMES=/tmp/frames bun run test:pty:markdown   # garde les échantillons
bun run coder -- --harness fake                         # puis taper « markdown » ou « markdown chars »
```
