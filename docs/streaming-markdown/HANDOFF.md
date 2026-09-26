# Handoff : un composant markdown stable pendant le streaming

Branche `feat/streaming-markdown`, worktree herdr
`~/.herdr/worktrees/airtty/feat-streaming-markdown`, partie de `main` à `79410fc`. Ce
document résume une investigation faite dans la session qui a construit `examples/coder` ;
tout ce qui est chiffré ici a été mesuré, le reste est marqué comme hypothèse.

## 1. Mission

Écrire un composant markdown pour OpenTUI (React) qui reste **visuellement stable pendant
le streaming** : le texte déjà affiché ne bouge plus, ne clignote pas entre brut et mis en
forme, et la hauteur ne fait que croître. Référence d'approche : **Streamdown de Vercel**
(`github.com/vercel/streamdown`). Premier client : le transcript de `examples/coder`
(messages et blocs « thinking » des agents). Le composant doit pouvoir remplacer
`<markdown>` d'OpenTUI dans `examples/coder/components/Transcript.tsx` pour les messages en
cours **et** terminés (même rendu, pas de saut à la fin).

Travaille en autonomie, commits atomiques (corps qui explique le pourquoi),
`bun run verify` vert avant chaque commit significatif, `docs/streaming-markdown/STATUS.md`
tenu à jour. **Ne merge pas dans `main` et ne pousse pas.** Arrête-toi seulement pour une
décision qui revient à l'utilisateur (voir §8).

## 2. Le problème, mesuré

Symptôme vu par l'utilisateur avec `coder --harness claude` : pendant qu'une réponse
s'écrit, le texte « jitter / blink » frénétiquement, puis s'affiche correctement une fois
la réponse finie.

Cause racine dans **OpenTUI 0.5.12** (dernière version publiée ;
`node_modules/@opentui/core/index.node.js`, classe `MarkdownRenderable`) :

- En mode par défaut `internalBlockMode: "coalesced"`, le markdown ordinaire (titres,
  paragraphes, listes) est regroupé en **un seul bloc** rendu par un `CodeRenderable`
  (filetype `markdown`, coloration Tree-sitter **asynchrone** dans un worker).
- En streaming, à chaque changement de contenu, le bloc de fin est redessiné depuis un
  **aperçu** (`createInitialStyledText(token)` → `renderInlineContent`) avant que la
  coloration revienne. Pour un bloc coalescé multi-blocs, l'aperçu lexe le brut comme du
  texte inline : `## Titre`, les puces, etc. apparaissent **bruts**, puis la coloration
  masque les marqueurs (`conceal`). Le message entier bascule brut ↔ mis en forme à
  chaque delta ; les deux versions n'ont pas la même longueur, donc pas le même
  repliement : la hauteur change et le défilement collant saute.

Mesures (réponse longue du harness factice, écran échantillonné toutes les ~5 ms, voir
§6) :

| Variante                                                      | Découpage    | Oscillations (ligne A→B→A) | Frames avec marqueurs bruts |
| ------------------------------------------------------------- | ------------ | -------------------------- | --------------------------- |
| `<markdown streaming conceal>` (avant correctif)              | par mots     | **301** (253 titres)       | —                           |
| `conceal` seulement une fois fini (**état actuel de `main`**) | par mots     | 66 (sauts de défilement)   | —                           |
| idem                                                          | 3 caractères | 0                          | 1353 / 4423 (voulu)         |
| `internalBlockMode="top-level"` + `conceal`                   | par mots     | 0                          | 0                           |
| idem                                                          | 3 caractères | 0                          | 64 / 4380                   |

État actuel de `main` (commit `2c82de8`) : `Transcript.tsx` ne masque les marqueurs
qu'une fois l'item terminé (`concealed(item)`) ; pendant le streaming on voit `**gras**`
et `## titre` bruts, puis la réponse prend sa forme finale d'un coup.

`internalBlockMode="top-level"` est une piste bon marché **non appliquée** : elle est
marquée « Internal only » dans les types d'OpenTUI. Les 64 frames restantes viennent d'un
marqueur ouvert (`**som`) qui reste brut jusqu'à sa fermeture. Garde-la comme
**référence de comparaison** pour ton composant (il doit faire au moins aussi bien).

## 3. Streamdown : ce qu'il faut en reprendre

À étudier dans le code source (`git clone --depth 1 https://github.com/vercel/streamdown`),
les points ci-dessous sont à **vérifier**, pas à croire sur parole :

- **Découpage en blocs** avec le lexer de `marked` (`parseMarkdownIntoBlocks` ou
  équivalent) ; chaque bloc est un composant mémoïsé : seuls les derniers se re-rendent.
- **Markdown incomplet** : fermeture optimiste des marqueurs ouverts du bloc de fin
  (gras, italique, code inline, liens, blocs de code) — paquet `remend`, anciennement
  `parseIncompleteMarkdown`. Regarder ses heuristiques et ses cas de test : c'est la
  partie la plus délicate.
- Coloration des blocs de code (Shiki côté web), tableaux GFM, sécurité des liens /
  images, maths. Pour un terminal, seules les idées comptent ; l'implémentation React DOM
  ne se transpose pas.

Documente dans `STATUS.md` ce que tu en reprends et ce que tu écartes.

## 4. Architecture proposée (à challenger)

- **Blocs figés** : lexer le message (`marked` 17.0.1, déjà au catalogue racine), figer
  tous les blocs de premier niveau sauf le(s) dernier(s) ; un bloc figé est rendu une fois
  (clé stable + `memo`) et n'est plus jamais recalculé. OpenTUI exporte aussi
  `parseMarkdownIncremental(newContent, prevState, trailingUnstable)` : à évaluer.
- **Inline synchrone** : titres, gras, italique, code inline, liens rendus en
  `StyledText` / `TextRenderable` **sans Tree-sitter** : l'aperçu et le rendu final sont
  identiques par construction. Styles via le `SyntaxStyle` existant
  (`examples/coder/components/syntax.ts`, groupes `markup.*`).
- **Fermeture optimiste** sur le bloc de fin (façon `remend`).
- **Blocs de code** : texte brut tant que la clôture n'est pas arrivée, puis `<code>`
  d'OpenTUI (Tree-sitter) une seule fois ; ne jamais faire clignoter le texte, au plus
  les couleurs.
- **Tableaux** : largeurs qui changent à chaque ligne → afficher une fois complets, ou
  largeurs figées ; à décider sur mesure.
- **Fin du streaming** : une ré-analyse complète (corrige les cas non locaux), rendu
  identique à celui du streaming quand rien n'a changé.

## 5. Défis connus

1. **Markdown non local** : titre setext (`---` sous un paragraphe), continuation
   paresseuse, liste qui devient « lâche », bloc de code ouvert qui avale la suite,
   définitions de liens par référence plus loin, HTML en bloc. Figer prudemment (jamais
   dans une clôture ouverte, pas les derniers blocs).
2. **Fermeture optimiste heuristique** : `*` de liste ou de calcul, `snake_case`,
   backticks multiples, `**` dans du code.
3. **Fidélité** : listes imbriquées, numérotation, cases à cocher, citations imbriquées,
   filets, liens (texte + URL comme OpenTUI, OSC 8 à considérer), largeurs Unicode
   (laisser `TextRenderable` gérer le repliement).
4. **Parité** avec le rendu actuel des messages terminés (marges entre blocs, puces,
   couleurs) ; sélection à la souris et OSC 52 du transcript doivent continuer à marcher.
5. **Performance** : un message de 10 k tokens à ~20 deltas/s ; ne relexer que la queue.
6. **Cible web** : airtty rend aussi dans un navigateur ; n'utiliser que des primitives
   OpenTUI (box, text, code) pour rester portable.

## 6. Mesurer (le banc d'essai)

Le script d'échantillonnage ci-dessous (écrit à la volée, pas au niveau du lint : à
reprendre proprement, par exemple en `scripts/pty/markdown-stability.ts`) lance coder sur
le harness factice, envoie `hello` et enregistre l'écran toutes les ~5 ms ;
`bench/oscillations.py` compte les lignes qui passent de A à B puis reviennent à A en
moins de 3 frames.

```ts
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { drive, Keys } from "./driver";
import { BUN, CLI, example, temporaryDirectory } from "./harness";
using directory = temporaryDirectory("airtty-jitter-");
const project = join(directory.path, "project");
mkdirSync(project);
await using t = await drive({
  command: [BUN, CLI, "dev", "--app", example("coder"), "--", "--harness", "fake"],
  cols: 100,
  rows: 30,
  cwd: project,
  env: { XDG_STATE_HOME: join(directory.path, "state"), CODER_FAKE_DELAY_MS: "8" },
  settle: 300,
});
await t.waitFor("scripted demo is ready", { timeout: 60_000 });
await t.type("hello");
await t.type(Keys.enter);
const frames: string[][] = [];
const start = Date.now();
while (Date.now() - start < 25_000) {
  frames.push(await t.lines());
  await Bun.sleep(5);
}
await Bun.write(process.env.OUT + "/jitter-frames.json", JSON.stringify(frames));
```

Pour les mesures du §2, le harness factice a été modifié **temporairement** (non commité) :
`REPLY` précédé de 12 sections `## Section i` / paragraphe avec `**gras**`, `` `code` `` et
un lien / liste de deux puces ; et, pour le découpage « 3 caractères », la boucle de
`stream()` de `examples/coder/server/adapters/fake.ts` passée de
`text.match(/\S+\s*/g)` à `text.match(/[\s\S]{1,3}/g)`. Rends ça permanent et propre : un
mot-clé du harness factice (par exemple `markdown`) qui streame une longue réponse riche
(titres, listes imbriquées, code, tableau, citation) en petits morceaux, et un parcours
PTY qui **échoue** au-delà d'un seuil d'oscillations.

## 7. Critères de fin

1. Composant (emplacement à choisir : `examples/coder/components/` d'abord, promotion
   dans `packages/airtty` seulement si l'utilisateur le demande) utilisé par le transcript
   de coder pour messages et « thinking », en cours et terminés.
2. Banc PTY : **0 oscillation** et marqueurs bruts ≤ la variante `top-level` sur la
   réponse riche, en découpage par mots et par 3 caractères.
3. Tests unitaires : propriété « un bloc figé ne change jamais » (rendu de tous les
   préfixes d'un corpus), fermeture optimiste (table de cas), rendu fini identique au
   rendu streamé ; `testRender` d'OpenTUI comme dans `tests/coder*.test.tsx`.
4. `bun run verify` vert, `test:pty:coder` vert, un essai réel court avec
   `bun run coder -- --harness claude` (consomme un peu de quota : une seule réponse).
5. `STATUS.md` : décisions, écarts avec Streamdown, mesures avant / après.

## 8. Décisions qui reviennent à l'utilisateur

- Promouvoir le composant dans `packages/airtty` (API publique) plutôt que de le garder
  dans l'exemple.
- Ajouter une dépendance au-delà de `marked` (déjà au catalogue).
- Abandonner la parité visuelle avec `<markdown>` d'OpenTUI sur un point visible.

## 9. Conventions du repo (rappel)

- Bun 1.4.2, TS, zod 4.6.5, OpenTUI 0.5.12, React 19.3.0. `bun install --frozen-lockfile`
  à la racine **et** dans `website/`, puis `bunx astro sync` dans `website/`, sinon
  `bun run lint` échoue sur le site.
- Docs et README en **français** ; code, commentaires, textes d'UI et commits en
  **anglais**. Commits `type(scope): sujet` ≤ 72 caractères, corps qui explique le
  pourquoi (fix : symptôme, cause, solution), trailer `Co-Authored-By`.
- Lint strict : pas de `any`, pas de `as` (sauf `as const`), pas de `!`, constantes
  nommées, pas de promesses flottantes, Zod aux frontières externes.
- Dépendance : pin exact dans le catalogue, ligne dans `docs/DEPENDENCIES.md`,
  `bun audit` rend `{}`.
- Jamais de `git stash` nu (pile partagée entre worktrees).
