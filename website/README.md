# website : le site d'airtty

Site statique en Astro 7 et TypeScript, en anglais (public open source) :

| Page         | Rôle                                                                               |
| ------------ | ---------------------------------------------------------------------------------- |
| `/`          | la landing : quatre blocs, une seule démo live (Notes, dans le hero)               |
| `/examples/` | chaque exemple par usage ; démos live au clic, une seule à la fois                 |
| `/status/`   | statut du projet, vérifié à la main contre le README et `docs/` (date et révision) |
| `/docs/…`    | la documentation, en anglais : `src/content/docs/`, voir plus bas                  |
| `/guide/`    | le guide, en français                                                              |
| `/og/`       | l'image de partage, photographiée par `scripts/og.ts` dans `public/og.png`         |

Ce que la landing v2 a retiré, et où le retrouver : [DOCS-BACKLOG.md](DOCS-BACKLOG.md).

## La documentation

Une page par fichier MDX de `src/content/docs/` (collection `docs`, `src/content.config.ts`) ;
l'ordre de la barre latérale, du sommaire et des liens précédent/suivant est
`src/lib/docs/nav.ts`, et une page absente de cette liste fait échouer le build. Chaque page
cite ses sources dans son front matter (`sources`), vérifiées au build, et montre le code du
dépôt par `Excerpt` (`src/components/guide/`), trouvé par repères comme dans le guide.

Le nom du produit et les commandes viennent de `src/lib/product.ts` : les pages s'écrivent
avec le nom actuel, et un plugin de `src/lib/docs/markdown.ts` le réécrit partout si ce
fichier change (les props des composants, du JavaScript, lisent `product.ts` elles-mêmes).
La recherche est Pagefind : `bun run build` indexe `dist/` après Astro (le seul
`data-pagefind-body` est celui des pages de documentation) ; `bun run dev` n'a pas d'index et
le dit.

```sh
cd website
bun install --frozen-lockfile
bun run dev        # http://localhost:4321
bun scripts/og.ts http://localhost:4321   # public/og.png, après un changement de palette ou de capture
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

## Les démos live sont reconstruites, pas copiées à la main

Le hero fait tourner Notes dans la page : `airtty build --web-local` de `examples/notes`,
Client et Server dans l'onglet (voir `docs/WEB.md`). `scripts/demo.ts` refait ce build
pour chaque démo (`forge`, `notes`, `mdreader`, `chat`, `coder`, `devtools`) et copie `.airtty/web/`
sans les source maps dans
`public/demo/<app>/`, que Git ignore. Le runtime web, commun à toutes les applications, est
publié une fois dans `public/demo/runtime/` : la première démo lancée met en cache les plus
gros fichiers des autres. Après un changement du framework ou d'un exemple, relancer
`bun run demo` ; si le framework a changé, le runtime web est reconstruit et demande Zig
0.16.0 (`ZIG=/chemin/vers/zig bun run demo`). Sans cette étape, la page se construit
quand même, mais le hero reste sur sa capture.

`LiveTerminal.astro` dessine d'abord la capture de l'écran (aucune attente, aucun décalage),
démarre l'application derrière elle dans un `iframe` à la même grille, affiche les étapes
du démarrage, déroule un script (sur `/examples/`, Forge : connexion en alice, un diff), puis
remplace la capture. Chaque étape attend son texte 8 s, ou le `timeout` qu'elle donne
(coder : 45 s, son agent scripté répond en flux) ; si une étape expire quand même,
l'application s'affiche telle quelle et une ligne sous l'écran dit quel texte n'est pas
venu. Un clic sur l'écran donne le clavier à l'application, un clic ailleurs
le rend à la page. Sous 760 px de large ou avec l'économie de données, rien ne démarre : un
lien ouvre la démo dans sa propre page.

La landing n'en fait tourner qu'une : Notes, dans le hero, dont la page règle l'aller-retour
et la perte de la prochaine réponse ; elle démarre près du viewport et s'arrête loin de lui.
Les autres (coder, Forge, Chat, mdreader, DevTools) tournent sur `/examples/`, au clic, une seule
à la fois, arrêtée quand on la quitte. Chaque démo trouve autour d'elle ce que
`scripts/demo.ts` écrit dans `server-seed.json` : un environnement (`CHAT_DEMO=1`,
`MD_PATH=/docs`…) et, pour mdreader, les documents du dépôt en lecture seule.

Sur `/examples/`, coder (« Coding-agent interface ») tourne sans agent : `scripts/demo.ts`
le construit avec `CODER_HARNESS=fake`, aucun appel de modèle, et sa ligne d'état le dit
elle-même (« Scripted demo · no model calls »), comme le badge à côté de l'écran. Son
script de page (`src/lib/examples.ts`) : attendre « … is ready in … » (la session a
démarré ; `Message…` s'affiche avant, et les touches tapées alors se perdent), taper
`DEMO_PROMPT` puis Entrée, attendre `allow once`, taper `y`, attendre `DEMO_END`. `DEMO_PROMPT`
et `DEMO_END` sont lus dans `examples/coder/server/adapters/fake.ts` (`?raw`) : s'ils
changent de forme, le build échoue. L'écran d'arrivée est celui de `src/frames/coder.json` (scène `coder` de
`scripts/capture.py`, même prompt). La landing le montre en capture, avec « Play it » vers
`/examples/#coder`. Files et mux restent au
terminal : une bibliothèque d'images native pour l'un, des PTY pour l'autre.

La page lit aussi les sources de `examples/notes` à la compilation (`?raw`) : le code
montré dans « React components. A server side. » est celui du dépôt, découpé par motifs ;
un motif qui ne correspond plus fait échouer le build.
