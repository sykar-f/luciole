# @luciole/flow

Des graphes de nœuds dans le terminal, sur le modèle de
[React Flow](https://reactflow.dev) : mêmes noms (`nodes`, `edges`, `onNodesChange`,
`applyNodeChanges`, `useNodesState`, `nodeTypes`, `<Handle>`, `<MiniMap>`…), rendu par
OpenTUI. Paquet de l'espace de travail, encore privé (non publié), utilisé par
[`examples/flow`](../../examples/flow). Licence MIT.

```tsx
"use client";
import {
  addEdge,
  Background,
  Controls,
  Flow,
  MiniMap,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
} from "@luciole/flow";

export function Pipeline({ initial }: { initial: { nodes: Node[]; edges: Edge[] } }) {
  const [nodes, , onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  return (
    <Flow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={(c) => setEdges((e) => addEdge(c, e))}
      fitView
    >
      <Background />
      <Controls />
      <MiniMap />
    </Flow>
  );
}
```

`<Flow>` s'utilise dans un Client Component : pan, zoom, drag et sélection restent sur le
Client, sans aller-retour. Seul ce que l'application envoie elle-même (une Server Function
appelée depuis `onNodesChange`, `onConnect`…) atteint le Server.

## Ce qui change par rapport au navigateur

- **Coordonnées en cellules.** `position.x` compte des colonnes, `position.y` des lignes ;
  une ligne est environ deux fois plus haute qu'une colonne n'est large.
- **Zoom sémantique.** Trois niveaux (`ZOOMS` : 1, ½, ¼). Dézoomer rapproche les nœuds et
  en dessine moins : le composant du nœud (`full`), son label sur une ligne (`compact`),
  un point (`dot`). Un composant de `nodeTypes` reçoit `detail` ; au niveau `dot`, le
  canevas dessine le point lui-même, dans `node.color`.
- **Arêtes sur la grille.** `smoothstep` (défaut, coins arrondis `╭╮╰╯`) et `step`
  (`┌┐└┘`) en caractères de boîte ; les traits de toutes les arêtes d'une cellule
  fusionnent (`├ ┤ ┬ ┴ ┼`), ce qui dessine aussi les fourches et les croisements.
  `bezier` et les `straight` obliques en braille (`braille={false}` les ramène à
  `smoothstep`). Marqueurs `▶◀▲▼`, labels, `animated` : tirets `╌╎` et des traits pleins
  qui avancent vers la cible.
- **Types d'arêtes.** Une entrée de `edgeTypes` est un style intégré ou une fonction qui
  rend les coins du tracé (`EdgeRoute`), dessiné en caractères de boîte : pas de
  composant de rendu libre comme le SVG de React Flow.
- **Nœuds.** `default` (bordure arrondie), `input` (double), `output` (épaisse), `group`
  (cadre de taille fixe ; ses enfants ont `parentId` et une position relative). Sans
  `<Handle>`, un nœud reçoit ses arêtes à gauche et les émet à droite
  (`targetPosition`/`sourcePosition`) : un flux se lit de gauche à droite, où le
  terminal a de la place. Les textes d'un nœud personnalisé doivent être
  `selectable={false}`, sinon un clic y commence une sélection de texte au lieu d'un drag.

## Clavier (groupe `flow`, `keyboard={false}` pour le couper)

Les raccourcis passent toujours par `@opentui/keymap` (`useBindings`). Dans une
application qui a son `<KeymapProvider>` (le Shell de luciole en installe un), ils
rejoignent ses couches : `<KeyHelp>` les liste et les couches de l'application peuvent
les masquer. Sans provider, le canevas installe le sien, une seule keymap par renderer
(elle n'a pas de `dispose`) : rien à envelopper pour que le clavier marche.

| Touches                        | Action                                                      |
| ------------------------------ | ----------------------------------------------------------- |
| `h j k l`, flèches             | Déplacer la vue                                             |
| `H J K L`, Maj+flèches         | Déplacer les nœuds sélectionnés d'une cellule               |
| `tab`, `Maj+tab`               | Nœud suivant, précédent (par colonnes, de gauche à droite)  |
| `]`, `[`                       | Suivre une arête vers l'aval, vers l'amont                  |
| `}`, `{`                       | Nœud frère suivant, précédent                               |
| `c`, puis `tab`/`]`…, `Entrée` | Connecter le nœud sélectionné à la cible proposée (`Échap`) |
| `e`                            | Sélectionner tour à tour les arêtes du nœud                 |
| `x`, `Suppr`                   | Supprimer la sélection (un nœud emporte ses arêtes)         |
| `=` `+`, `-`, `0`              | Zoomer, dézoomer, tout voir                                 |
| `Échap`                        | Tout désélectionner                                         |

## Souris

Clic : sélection (Maj : ajout). Glisser un nœud le déplace (avec les autres nœuds
sélectionnés), glisser le fond déplace la vue, glisser depuis un handle (`●`, affiché
sur le nœud sélectionné) trace une connexion jusqu'à un nœud. Molette : déplacer la vue
(Maj : horizontalement) ; Ctrl ou Alt + molette : zoom. Un clic dans la minimap y centre
la vue.

## API

| Export                                            | Rôle                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `<Flow>`                                          | Le canevas ; voir `FlowProps`.                                                       |
| `<Background variant? gap? color?>`               | Points (`dots`), grille (`lines`) ou croix (`cross`) sous les arêtes.                |
| `<MiniMap position? width? height?>`              | Les nœuds en braille et la vue encadrée ; un clic y déplace la vue.                  |
| `<Controls position?>`, `<Panel position>`        | Boutons de zoom ; contenu libre dans un coin.                                        |
| `<Handle type position id?>`                      | Point d'attache déclaré par un nœud personnalisé ; plusieurs par côté sont répartis. |
| `useNodesState`, `useEdgesState`                  | `useState` et le `on…Change` qui applique les changements.                           |
| `useFlow()`                                       | `fitView`, `setViewport`, `setCenter`, `reveal`, `zoomIn/Out`, `getNodes`, `select`… |
| `useViewport()`                                   | La vue et le niveau de détail courants.                                              |
| `<FlowProvider>`                                  | Partage le canevas avec des composants hors de `<Flow>` (panneau latéral).           |
| `applyNodeChanges`, `applyEdgeChanges`, `addEdge` | Comme dans React Flow.                                                               |
| `composeFrame`, `hitTest`, `Grid`                 | La frame sous les nœuds, en fonction pure : tests, rendus hors canevas.              |

## Origine du code

Le routage orthogonal des arêtes, les points de contrôle bezier et l'application des
changements sont repris de xyflow (MIT) dans [`src/vendor/xyflow`](src/vendor/xyflow/README.md),
qui explique pourquoi le paquet `@xyflow/system` n'est pas une dépendance. Tout le rendu
et l'interaction sont propres au terminal.

## Paquet, build et tests

| Quoi               | Comment                                                                                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pairs              | `react`, `@opentui/core`, `@opentui/react`, `@opentui/keymap` en `peerDependencies` : une seule copie, celle de l'application. Aucune dépendance propre.                                                                                                                  |
| Build              | `bun run build` (dans `packages/flow`) : `dist/`, ESM seul, un fichier par module, imports en `.js`, déclarations `.d.ts`, TypeScript 7. Pas de CommonJS.                                                                                                                 |
| `exports`          | `bun` → `src/index.ts` (Bun compile les sources, avec le `tsconfig.json` livré), sinon `types` → `dist/index.d.ts` et `default` → `dist/index.js`.                                                                                                                        |
| Dans le dépôt      | Rien à construire : Bun et `luciole build` prennent la condition `bun` ; un consommateur TypeScript la déclare (`"customConditions": ["bun"]`, voir `examples/flow/tsconfig.json`).                                                                                       |
| Tests (`bun test`) | `test/raster.test.ts` (frames texte attendues), `test/model.test.ts` (géométrie, store, navigation), `test/canvas.test.tsx` (souris et clavier sur le canevas rendu, avec et sans keymap de l'application), `test/package.test.ts` (le build et le manifeste publiables). |
