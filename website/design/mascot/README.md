# luciole — sprite animé

La luciole « hug lantern » en pixel art (66×93), qui flotte pendant que sa lanterne
respire et l'éclaire. Boucle de 6,4 s : deux respirations, antennes en retard, un clignement.

## Fichiers

| Fichier              | Rôle                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `master/color.png`   | **Source de vérité** : couleurs, 1 px = 1 pixel du sprite, fond transparent                       |
| `master/classes.png` | Rôle de chaque pixel (couleurs ci-dessous)                                                        |
| `master/light.png`   | Lumière de la lanterne reçue : noir = aucune/ombre, blanc = pleine (4 niveaux)                    |
| `build.mjs`          | `master/*.png` → `luciole-data.js`, sans requantifier (les retouches sont conservées)             |
| `luciole-sprite.js`  | Moteur de rendu + `CYCLE` (le timing partagé par la démo et l'export)                             |
| `export.mjs`         | → `out/` : spritesheets (sombre et clair), `spritesheet.json`, images fixes, GIF, frames          |
| `luciole-mascot.js`  | Composant `<luciole-mascot>` pour le site (lit la spritesheet)                                    |
| `index.html`         | Démo : réglage en direct, composant, états figés                                                  |
| `extract.py`         | Amorçage unique depuis l'image IA — **écrase `master/`**, à ne relancer que pour repartir de zéro |
| `ref/`               | Références d'éclairage générées (faible, moyenne, forte)                                          |

## Retoucher dans Aseprite

1. Ouvrir `master/color.png` ; importer `classes.png` et `light.png` comme calques de référence.
2. Retoucher les pixels. Si on ajoute ou retire un pixel dans `color.png`, faire de même dans
   `classes.png` (et `light.png` si le pixel doit recevoir de la lumière).
3. Exporter les trois calques en PNG **taille 1×**, puis :
   ```sh
   node build.mjs && node export.mjs
   ```
   `build.mjs` refuse un fichier incohérent (tailles différentes, couleur de classe inconnue,
   pixel opaque sans classe) et indique les coordonnées fautives.

Couleurs de `classes.png` :

| Couleur   | Rôle           | Effet dans l'animation                                                |
| --------- | -------------- | --------------------------------------------------------------------- |
| `#808080` | corps          | assombri avec la lanterne, éclairé selon `light.png`                  |
| `#c6e85a` | lanterne       | ses teintes glissent le long de la rampe (les anneaux sont conservés) |
| `#ffa000` | bout d'antenne | brille avec un léger retard, halo propre                              |
| `#3070ff` | œil            | fermé par le clignement                                               |
| `#ff40a0` | tige d'antenne | suit le corps avec un temps de retard                                 |

## Sur le site

```html
<script type="module" src="/mascot/luciole-mascot.js"></script>
<luciole-mascot
  src="/mascot/spritesheet.png"
  meta="/mascot/spritesheet.json"
  still="/mascot/still.png"
  scale="2"
>
  <img src="/mascot/still.png" alt="" />
</luciole-mascot>
```

- `scale` : pixels du sprite → pixels CSS, arrondi à un nombre entier de pixels physiques.
- Fond clair : `spritesheet-light.png` / `still-light.png` (halo réduit).
- Décoratif par défaut (`aria-hidden`) ; `label="…"` pour l'exposer comme image.
- « Réduire les animations » → image fixe ; pause hors écran et dans les onglets en arrière-plan.

## Démo

```sh
python3 -m http.server 8765   # puis http://localhost:8765
```

## Petite version (terminal, avatars ≤ 32 px)

`luciole-small.js` est un dessin séparé de 30×42 (lueur comprise), pas une réduction :
voir `small/README.md`. `node terminal.mjs` l'imprime en demi-blocs (30 colonnes × 21 lignes),
message utile d'abord ; `node terminal.mjs 2` montre l'ancienne réduction pour comparer.

## Variantes exportées

- `spritesheet-start.png` : flottement de 1 px, pour la section Start (assise sur le bloc).
- `spritesheet-light.png` / `still-light.png` : halo réduit et anneaux de lanterne moins olive, pour fond clair.
- `<luciole-mascot>` lit son échelle dans `scale`, sinon dans la variable CSS `--luciole-scale`
  (une media query peut la réduire sur mobile).
