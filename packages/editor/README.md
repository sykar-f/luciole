# @luciole/editor

Un éditeur Markdown **WYSIWYG** pour le terminal : le document s'affiche tel qu'il se lit
(titres sur leur bandeau, gras, listes à puces, cases à cocher, code coloré), aucun
marqueur Markdown n'apparaît à l'écran, et le Markdown tapé devient ce qu'il signifie au
fil de la frappe. Du Markdown entre (`value`), du Markdown sort (`onChange`). Paquet de
l'espace de travail, encore privé (non publié), utilisé par
[`examples/notes`](../../examples/notes). Licence MIT.

## Installation

```sh
bun add @luciole/editor luciole @opentui/core @opentui/react react
# ou : npm install @luciole/editor luciole @opentui/core @opentui/react react
```

`react`, `@opentui/core` et `@opentui/react` sont des pairs : une seule copie, celle de
l'application. `luciole` n'est pas une dépendance de l'éditeur : l'exemple ci-dessous en
tire `markdownStyle`, l'application l'a déjà. Le paquet est de l'ESM pur, avec ses déclarations ; il s'importe sous Bun
et sous Node.

```tsx
"use client";
import { useState } from "react";
import { MarkdownEditor } from "@luciole/editor";
import { markdownStyle } from "luciole/client";

const style = markdownStyle({ text: "#e6edf3", accent: "#e8b84a" /* … */ });

export function Note({ initial }: { initial: string }) {
  const [markdown, setMarkdown] = useState(initial);
  return (
    <MarkdownEditor
      value={markdown}
      onChange={setMarkdown}
      syntaxStyle={style}
      focused
      flexGrow={1}
    />
  );
}
```

## Ce qu'on tape

| Tapé                                       | Devient                                                           |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `**mot**`, `*mot*`, `` `mot` ``, `~~mot~~` | gras, italique, code, barré                                       |
| `# `, `## `… en début de ligne             | un titre de ce niveau                                             |
| `- `, `* `, `1. `, `[ ] `, `> `            | une liste à puces, numérotée, une tâche, une citation             |
| ` ``` ` puis Entrée, `---` puis Entrée     | un bloc de code (` ```ts ` : coloré en TypeScript), un séparateur |
| `[texte](url)`, une URL puis espace        | un lien                                                           |
| `\*`                                       | une étoile, telle quelle                                          |

**Fermeture automatique.** Un délimiteur tapé attend la touche suivante pour décider de
son sens : devant un mot il ouvre, après un mot il ferme, devant une espace il reste un
caractère (`2 * 3`). Ce qu'il ouvre se ferme sans qu'on tape la fermeture : en fin de
bloc, ou quand le curseur s'en va. Le Markdown émis est donc toujours équilibré.

**Retour arrière** juste après une conversion la défait et rend les caractères tapés
(`# ` redevient `# `). En début de titre, de liste ou de citation, il retire la marque du
bloc ; Entrée sur un élément de liste vide sort de la liste.

Un délimiteur tapé sur une sélection l'entoure (`**` met la sélection en gras). Coller
insère du Markdown : blocs et marques arrivent tels quels.

## Architecture

Quatre couches, chacune utilisable seule, les trois premières sans terminal :

- **`model/`** : le document, immuable. Des blocs (paragraphe, titre, citation, élément
  de liste, code, brut, séparateur) dont le texte est une suite de segments marqués. Une
  position est un bloc et un décalage dans son texte.
- **`markdown/`** : l'aller-retour avec Markdown (lexer GFM de `marked`). Ce que
  l'éditeur ne modélise pas (tableaux, HTML, images) est gardé caractère pour caractère.
  Un bloc non modifié est réécrit exactement comme il a été lu : ouvrir et fermer une note
  ne la reformate pas.
- **`editing/`** : les éditions comme fonctions pures d'un état (`commands.ts`), les
  règles de saisie (`rules.ts`), l'historique par instantanés (`history.ts`) et
  `EditorController`, qui les réunit sans écran.
- **`view/`** : la mise en page (retour à la ligne par mots, correspondance position ↔
  cellule), le dessin, la table des touches (des intentions, testables sans terminal),
  la coloration Tree-sitter des blocs de code, le renderable OpenTUI et le composant React.

Les couleurs viennent du `SyntaxStyle` passé en `syntaxStyle`, avec les mêmes groupes que
le `<Markdown>` de luciole (`markup.heading.1`, `markup.raw.block`…) :
`markdownStyle(palette)` de `luciole/client` en construit un complet.

## Ce qui est vérifié

- **Les 652 exemples de la spec CommonMark 0.31.2** et un corpus GFM (`test/spec.test.ts`) :
  lu puis réécrit de zéro, chaque exemple garde son sens (le HTML de `marked`, le lecteur
  de luciole, réduit à ce qu'un terminal affiche), et la forme réécrite est stable.
- **5 000 documents aléatoires** (`test/fuzz.test.ts`, graine fixe ; 50 000 passent aussi) :
  citations, listes imbriquées, contenu d'éléments, code, marques croisées, caractères
  spéciaux. Écrits en Markdown puis relus, ils reviennent identiques.
- **La frappe, touche par touche** (`test/typing.test.ts`), à travers le vrai décodage des
  touches d'OpenTUI, sur trois claviers : xterm, protocole kitty (touches en séquences
  d'échappement), Mac AZERTY (`[ ] { } | ~ \` avec Option). Même Markdown, même écran.
- **Le rendu, cellule par cellule** (`test/view.test.tsx`) : bandeaux des titres (H1 sur
  trois lignes, plein jusqu'à la colonne 28 puis dégradé jusqu'au bord), espacements,
  barres de citation, alignement du contenu des listes, panneau de code coloré, barre de
  défilement (pouce, espace de fin, glisser, note courte sans barre).

L'écriture des marques se vérifie elle-même : `marked` s'écarte de CommonMark sur
certaines suites de délimiteurs mêlés (`~~*`, `***`), donc chaque texte formaté est relu, et
d'autres graphies sont essayées (`_`, `__`, imbrication inverse, puis balises `<em>`) jusqu'à
ce qu'il se relise tel quel.

## Limites connues

- Une citation **à l'intérieur** d'un élément de liste (`- a` puis `  > b`) reste affichée
  comme son Markdown : les citations contiennent des listes, pas l'inverse.
- Les tableaux, le HTML et les définitions de liens s'éditent comme leur Markdown.
- Les images s'affichent comme leur Markdown (`![alt](src)`).
- Un soulignement setext (`===` sous un paragraphe) ne se tape pas : Entrée sépare déjà
  les blocs, comme une ligne vide.

## Défilement

L'éditeur défile lui-même, à la molette, au clavier (le curseur reste en vue) et pendant
la frappe. Une **barre de défilement** discrète descend sa dernière colonne dès que le
document dépasse sa hauteur : un pouce dans la couleur `conceal` du style (celle des
filets), long comme la part visible du texte, placé où en est la lecture, en demi-lignes
(`█ ▀ ▄`, comme les `ScrollBox` d'OpenTUI). Il se glisse ; un clic sur la piste y amène
la page. Avec `readingWidth`, la barre se tient dans la marge de la page ; sans marge,
l'éditeur garde sa dernière colonne pour elle, affichée ou non, pour que le texte ne
bouge pas quand elle apparaît. `scrollbar={false}` la retire (et rend la colonne).

Un document qui dépasse défile **au-delà de sa dernière ligne** d'un quart de la hauteur
visible : la fin du texte se lit à hauteur d'œil, pas collée au bord. Cet espace n'est
pas du contenu : rien dans le Markdown, le curseur n'y va pas, et un document qui tient à
l'écran ne défile pas du tout. `wheelRoom()` en tient compte : dans une page web
(docs/WEB.md, `lucioleScrollRoom`), la page ne reprend la molette qu'une fois cet
espace parcouru. La géométrie est pure (`src/view/scrollbar.ts`, `test/scrollbar.test.ts`).

## Depuis l'extérieur

Le `ref` donne le renderable, dont `controller` édite et formate depuis une barre
d'outils : `toggleMark("bold")`, `setBlock({ type: "heading", level: 2 })`,
`indent(1)`, `undo()`, `redo()`, `end()`. `activeMarks` et `block` disent ce qui est
actif sous le curseur ; `subscribe(listener)` prévient de chaque changement.

Les raccourcis de l'application passent avant ceux de l'éditeur (OpenTUI ne donne une
touche au renderable focalisé que si aucun gestionnaire global ne l'a prise).
