# Code repris de xyflow

Les fichiers de ce répertoire sont adaptés de [xyflow](https://github.com/xyflow/xyflow)
(React Flow), sous licence MIT ; la notice d'origine est dans [LICENSE](LICENSE).

Révision : `3d35b57317576b0916c0bfeaaedd573aaacc2839` (`@xyflow/system` 0.0.83,
`@xyflow/react` 12.12.0).

| Fichier         | Origine                                                                                                                                                                   | Adaptation                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `smoothstep.ts` | `packages/system/src/utils/edges/smoothstep-edge.ts` (`getPoints`)                                                                                                        | Les points du tracé orthogonal sont rendus tels quels (pas de chemin SVG ni de virages arrondis) : la grille les dessine en caractères de boîte. |
| `bezier.ts`     | `packages/system/src/utils/edges/bezier-edge.ts` (`calculateControlOffset`, `getControlWithCurvature`, `getBezierEdgeCenter`), `utils/edges/general.ts` (`getEdgeCenter`) | Points de contrôle rendus en nombres, pas en chemin SVG ; `Position` en chaînes.                                                                 |
| `changes.ts`    | `packages/react/src/utils/changes.ts` (`applyChanges`, `applyChange`), `packages/system/src/utils/edges/general.ts` (`addEdge`, `getEdgeId`, `connectionExists`)          | Typé sans `any` ; pas de `dimensions`/`resizing` sur les attributs (le terminal mesure, il ne redimensionne pas) ; `addEdge` sans `onError`.     |

Pourquoi recopier plutôt que dépendre de `@xyflow/system` : le paquet s'importe sous Bun
sans DOM, mais il tire d3 (`d3-drag`, `d3-zoom`, `d3-selection`, `d3-interpolate`,
`d3-transition` et leurs types, 15 paquets) pour du code qui ne sert pas au terminal
(`XYPanZoom`, `XYDrag`, `XYHandle`, `XYResizer`, mesure par `getBoundingClientRect`), et ses
fonctions de tracé ne rendent que des chaînes SVG qu'il faudrait reparser. Ce qui sert tient
en quelques fonctions pures, reprises ici.
