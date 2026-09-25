# website : la page de présentation d'airtty

Page unique en Astro 7 et TypeScript, statique, en anglais (public open source).

```sh
cd website
bun install --frozen-lockfile
bun run dev        # http://localhost:4321
bun run demo       # public/demo/notes/ : la démo live, à lancer avant build
bun run build      # dist/, publiable sur n'importe quel hébergement statique
bun run check      # astro check : types des composants et scripts
```

## Hors de l'espace de travail

Comme `probes/`, `website/` a son propre `package.json` et son propre `bun.lock` et
n'apparaît pas dans `workspaces` : Astro, Vite et Shiki ne rejoignent pas le
`node_modules` hoisté du framework, où `tests/dependencies.test.ts` exige un seul React
et un seul OpenTUI. Oxlint et Oxfmt de la racine couvrent quand même ses sources.

`typescript` y reste en 6.0.2 : `astro check` ne prend pas encore TypeScript 7.

## Les écrans sont de vraies captures

Les terminaux de la page ne sont pas des maquettes. `scripts/capture.py` lance chaque
exemple avec `airtty dev` dans un PTY, joue des touches, et écrit l'écran décodé par
pyte (caractères, couleurs, attributs) dans `src/frames/<nom>.json`. `Screen.astro` le
redessine cellule par cellule en HTML : net à toute taille, sélectionnable.

```sh
python3 -m venv /tmp/airtty-pty && /tmp/airtty-pty/bin/pip install -r scripts/requirements-pty.txt
/tmp/airtty-pty/bin/python website/scripts/capture.py            # toutes les scènes, depuis la racine
/tmp/airtty-pty/bin/python website/scripts/capture.py --print mux # une scène, texte affiché
```

Le chemin absolu du checkout et le `$TMPDIR` de macOS sont remplacés par des chemins
neutres de même largeur. Forge démarre à une date fixe : les âges affichés ne dépendent
pas du jour de la capture. Après un changement visible d'un exemple, relancer la scène.

## La démo live est reconstruite, pas copiée à la main

« Try it in your browser » charge Notes dans un `iframe`, à la demande (~1,7 Mo
compressé) : `airtty build --web-local` de `examples/notes`, Client et Server dans
l'onglet (voir `docs/WEB.md`). `scripts/demo.ts` refait ce build et copie
`.airtty/web/` sans les source maps dans `public/demo/notes/`, que Git ignore : la démo
suit toujours le framework et Notes, sans binaires figés dans le dépôt. Après un
changement du framework ou de Notes, relancer `bun run demo` ; si le framework a changé,
le runtime web est reconstruit et demande Zig 0.16.0 (`ZIG=/chemin/vers/zig bun run demo`). Sans cette étape, la page
se construit quand même, avec un avertissement, mais le bouton mène à une 404.

La page lit aussi les sources de `examples/notes` à la compilation (`?raw`) : le code
montré dans « One codebase. Two programs. » est celui du dépôt.
