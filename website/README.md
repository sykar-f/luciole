# website : le site de luciole

Site statique en Astro 7 et TypeScript, en anglais (public open source) :

| Page         | Rôle                                                                                |
| ------------ | ----------------------------------------------------------------------------------- |
| `/`          | la landing : cinq blocs ; Notes deux fois dans le hero, trois exemples live dessous |
| `/examples/` | chaque exemple par usage ; démos live au clic, une seule à la fois                  |
| `/status/`   | statut du projet, vérifié à la main contre le README et `docs/` (date et révision)  |
| `/docs/…`    | la documentation, en anglais : `src/content/docs/`, voir plus bas                   |
| `/guide/`    | le guide, en français                                                               |
| `/og/`       | l'image de partage, photographiée par `scripts/og.ts` dans `public/og.png`          |

## La documentation

Une page par fichier MDX de `src/content/docs/` (collection `docs`, `src/content.config.ts`) ;
l'ordre de la barre latérale, du sommaire et des liens précédent/suivant est
`src/lib/docs/nav.ts`, et une page absente de cette liste fait échouer le build. Chaque page
cite ses sources dans son front matter (`sources`), vérifiées au build, et montre le code du
dépôt par `Excerpt` (`src/components/guide/`), trouvé par repères comme dans le guide.

Le nom du produit et les commandes viennent de `src/lib/product.ts` : les pages s'écrivent
avec le nom actuel, et un plugin de `src/lib/docs/markdown.ts` le réécrit partout si ce
fichier change (les props des composants, du JavaScript, lisent `product.ts` elles-mêmes).
Le glossaire (`reference/glossary.mdx`) est rendu depuis `src/lib/docs/glossary.ts`, et le
même module lie, au build, la première occurrence de chaque terme d'une page à son entrée :
on ajoute un terme là, jamais dans les pages.
La recherche est Pagefind : `bun run build` indexe `dist/` après Astro (le seul
`data-pagefind-body` est celui des pages de documentation) ; `bun run dev` n'a pas d'index et
le dit.

Les polices (IBM Plex Mono et Sans, JetBrains Mono) sont dans `src/assets/fonts/`, avec leur
licence OFL : le build ne les télécharge pas, `vendor.sh` les rafraîchit.

```sh
cd website
bun install --frozen-lockfile
bun run dev        # http://localhost:4321
bun scripts/og.ts http://localhost:4321   # public/og.png, après un changement de palette ou de capture
bun run demo       # public/demo/notes/ : la démo live, à lancer avant build
bun run build      # dist/, publiable sur n'importe quel hébergement statique
bun run check      # astro check : types des composants et scripts
```

## Les composants des docs

Chaque visuel d'une page de `src/content/docs/` passe par un de ces composants : il a une
légende obligatoire et une version texte, et l'export Markdown (`scripts/docs-md.ts`, lu par
la démo mdreader) sait l'écrire. Un composant que l'export ne connaît pas l'arrête :
lui donner sa forme Markdown d'abord. `scripts/check-kit.ts` vérifie ces contrats dans le
HTML de chaque page, appelé par `scripts/check-html.ts` après `astro build` : une page qui
en casse un fait échouer `bun run build`. `tests/docs-kit.test.ts` les éprouve sur des pages
écrites à la main ; `tests/docs-md.test.ts` vérifie l'export.

| Composant                        | Props                                                                                                         | Ce que la page montre                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Screen` (`components/`)         | `frame` (nom dans `src/frames/` ou `Frame`), `caption`, `wide?`, `regions?`, `marks?`, `printed?`, `poweron?` | la capture, sa légende, sa transcription (`<details>` « Transcript », décrit l'écran) ; `wide` : 140 colonnes à 10 px à 1280 px ; `marks` : les régions de la capture (ou `regions`) encadrées, chaque numéro sur des cellules vides à côté de sa région (`lib/marks.ts`), et la légende que le `Screen` tient entre ses balises, une liste numérotée d'un item par région ; sans légende, ou sans place pour un numéro, le build échoue |
| `Sequence` (`components/guide/`) | `title`, `lanes`, `messages`, `caption`                                                                       | le diagramme, sa légende, la liste numérotée de ses messages (« The steps as text »)                                                                                                                                                                                                                                                                                                                                                     |
| `Excerpt` (`components/guide/`)  | `path`, `find?`, `until?`, `count?`, `after?`, `mark?`, `tone?`, `lang?`, `caption?`                          | le code trouvé par repères ; un `tone` non neutre écrit son côté (Client, Server, Wire, Build)                                                                                                                                                                                                                                                                                                                                           |
| `AnnotatedCapture` (`docs/`)     | `path` (depuis la racine), `notes` (`{ match, note }`, `note` en Markdown inline), `caption`                  | la capture, chaque `match` marqué et numéroté, puis les notes ; un `match` absent fait échouer le build                                                                                                                                                                                                                                                                                                                                  |
| `CodeAndScreen` (`docs/`)        | les props d'`Excerpt`, `frame`, `regions?`, `caption`                                                         | le code et l'écran qu'il dessine, côte à côte dès 880 px de large, l'un sous l'autre sinon                                                                                                                                                                                                                                                                                                                                               |
| `RunHere` (`docs/`)              | `demo` (dans `public/demo/`), `frame`, `name`, `caption`, `script?`, `latency?`                               | la capture et un bouton ; la démo ne se charge qu'au clic (rien vers `/demo/` avant) ; `latency` : un curseur sous la figure, de 0 à 2 000 ms, qui règle l'aller-retour entre le Client de la démo et son Server, en partant de cette valeur ; sans `latency`, pas de curseur                                                                                                                                                            |

```mdx
import AnnotatedCapture from "../../../components/docs/AnnotatedCapture.astro";
import CodeAndScreen from "../../../components/docs/CodeAndScreen.astro";
import RunHere from "../../../components/docs/RunHere.astro";
import Screen from "../../../components/Screen.astro";
import Excerpt from "../../../components/guide/Excerpt.astro";
import Sequence from "../../../components/guide/Sequence.astro";

<Excerpt
  path="examples/notes/app/error.tsx"
  find="export default function"
  until="^}"
  mark={["retry"]}
  tone="client"
  caption="The error screen is a Client Component: its button calls retry."
/>

<Screen frame="devtools-network" caption="The Network panel, both processes' requests." wide />

<Sequence
  title="A page"
  lanes={[
    { id: "client", label: "Client", tone: "client" },
    { id: "server", label: "Server", tone: "server" },
  ]}
  messages={[
    { from: "client", to: "server", label: "GET /render", n: 1 },
    { from: "server", to: "client", label: "Flight: the page", n: 2, back: true },
  ]}
  caption="One round trip per page."
/>

<CodeAndScreen
  path="examples/notes/app/notes/[id]/page.tsx"
  find="export default async function Page"
  until="^}"
  tone="server"
  frame="notes"
  caption="The page, and the screen the Client draws from it."
/>

<AnnotatedCapture
  path="website/src/frames/flight.txt"
  caption="The Server's answer for note 1."
  notes={[{ match: "1:R", note: "announces the page's stream." }]}
/>

<RunHere demo="notes" frame="notes" name="Notes" caption="Notes with note 1 open." />
```

Les props se lisent dans la source de la page : écrire des littéraux (chaînes, nombres,
tableaux, objets), pas de variables, que l'export ne saurait pas évaluer. Les couleurs
passent par `scripts/palettes.py --check` (en CI) : les lignes atténuées d'un extrait
(`--code-dimmed`) restent à 4,5:1 au moins.

## Hors de l'espace de travail

Comme `probes/`, `website/` a son propre `package.json` et son propre `bun.lock` et
n'apparaît pas dans `workspaces` : Astro, Vite et Shiki ne rejoignent pas le
`node_modules` hoisté du framework, où `tests/dependencies.test.ts` exige un seul React
et un seul OpenTUI. Oxlint et Oxfmt de la racine couvrent quand même ses sources.

`typescript` y reste en 6.0.2 : `astro check` ne prend pas encore TypeScript 7.

## Les écrans sont de vraies captures

Les terminaux de la page ne sont pas des maquettes. `scripts/capture.py` lance chaque
exemple avec `luciole dev` dans un PTY, joue des touches, et écrit l'écran décodé par
pyte (caractères, couleurs, attributs) dans `src/frames/<nom>.json`. `Screen.astro` le
redessine cellule par cellule en HTML : net à toute taille, sélectionnable.

```sh
python3 -m venv /tmp/luciole-pty && /tmp/luciole-pty/bin/pip install pyte
/tmp/luciole-pty/bin/python website/scripts/capture.py            # toutes les scènes, depuis la racine
/tmp/luciole-pty/bin/python website/scripts/capture.py --print mux # une scène, texte affiché
```

Le chemin absolu du checkout et le `$TMPDIR` de macOS sont remplacés par des chemins
neutres de même largeur. Forge démarre à une date fixe : les âges affichés ne dépendent
pas du jour de la capture. Après un changement visible d'un exemple, relancer la scène.

## Les démos live sont reconstruites, pas copiées à la main

Le hero fait tourner Notes dans la page : `luciole build --web-local` de `examples/notes`,
Client et Server dans l'onglet (voir `docs/WEB.md`). `scripts/demo.ts` refait ce build
pour chaque démo (`forge`, `notes`, `mdreader`, `chat`, `coder`, `latency`, `devtools`) et copie `.luciole/web/`
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

La landing en fait tourner plusieurs. Dans le hero, Notes deux fois, sur le même aller-retour
de 500 ms placé autrement : avant chaque touche à gauche (comme SSH, `delays: "keys"`), avant
chaque requête à droite (comme luciole) ; ce que le lecteur fait dans l'un est rejoué dans
l'autre (`typed`, puis `input`), et chaque écran mesure le temps de la touche à ses cellules.
Sous 760 px ou avec l'économie de données, les deux captures seules. Dans « What you can
build », les trois exemples démarrent l'un après l'autre après le chargement de la page et
ne s'arrêtent plus : choisir un onglet ne fait que changer celui qu'on voit. Leurs fichiers
sont préchargés (`<link rel="prefetch">`, écrits dans un `<template>` que le script n'active
que là où les démos tournent). Tant qu'un exemple n'est pas prêt, son écran est flou et le
dit (« Loading the live demo »). Les scripts lisent l'écran d'une démo par
`lucioleScreen()` (docs/WEB.md), à jour même hors de vue, où xterm.js cesse de dessiner.
Sur `/examples/`, chacune (coder, Forge, Chat, mdreader, DevTools) tourne au clic, une seule
à la fois, arrêtée quand on la quitte. Chaque démo trouve autour d'elle ce que
`scripts/demo.ts` écrit dans `server-seed.json` : un environnement (`CHAT_DEMO=1`,
`MD_PATH=/docs`…) et, pour mdreader, la documentation anglaise du site en Markdown
(`scripts/docs-md.ts`, que `scripts/capture.py` lit aussi), en lecture seule.

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
