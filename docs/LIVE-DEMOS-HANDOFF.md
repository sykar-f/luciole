# Handoff : l'écran live ne correspond pas toujours à sa capture

Branche `fix/live-demo-mismatch`, worktree herdr `~/.herdr/worktrees/luciole/fix-live-demo-mismatch`,
partie de `main` à `bd36eb4`.

## Le symptôme

Sur la landing (`website/`), chaque démo live montre d'abord sa capture, écrite dans un
xterm.js de la page réglé comme celui du runtime, puis l'application, chargée dans un
`iframe`, la remplace. Quand tout va bien, le remplacement est invisible (mesuré au pixel :
rien ne change dans le terminal). Mais **parfois, une fois l'app chargée, ce n'est pas
exactement la même page** : l'utilisateur voit l'écran changer au moment du remplacement.
Pas de reproduction précise fournie ; « parfois ». But : comprendre pourquoi, puis faire en
sorte que l'écran révélé soit celui de la capture (ou que la révélation attende qu'il le
soit).

## Où est le code

| Fichier                                                     | Rôle                                                                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `website/src/components/LiveTerminal.astro`                 | Poster xterm (`stand`), `iframe`, script (`play`), révélation (`reveal`), prise du clavier, `live:start` / `live:stop`               |
| `website/src/components/Hero.astro`                         | Forge, script `signIn` : alice ⏎ forge ⏎, `j`, ⏎, but « wants to merge feature/refund-idempotency »                                  |
| `website/src/components/Apps.astro`                         | Galerie : Forge (script `toDiff`), Chat (`ask`, but « Done. »), mdreader, DevTools ; une seule démo vivante                          |
| `website/src/components/Wire.astro`                         | Notes (Latency), sans script                                                                                                         |
| `website/src/lib/frames.ts`                                 | `ansi(frame)` : la capture en séquences ANSI                                                                                         |
| `website/scripts/capture.py`                                | Les captures (PTY + pyte), `LUCIOLE_DESKTOP=1`, horloge Forge fixe                                                                   |
| `website/scripts/demo.ts`                                   | Build des démos dans `public/demo/<app>/`, runtime partagé, `server-seed.json` (env, fichiers)                                       |
| `packages/luciole/src/web/embed.ts`, `web/platform/run.tsx` | Contrat d'embarquement (étapes, `input`, `network`, `event`, `?columns&rows&background&foreground`) ; docs/WEB.md « Page embarquée » |

## Comment la révélation se décide aujourd'hui

1. L'`iframe` signale `drawn` (premier rendu) ; `play()` déroule le script : chaque étape
   attend un texte à l'écran (lu dans le DOM xterm de l'`iframe`, même origine), tape, puis
   attend `pause` ms. Si le texte d'une étape ultérieure est déjà affiché (session
   restaurée), il saute ; s'il n'y a rien à attendre sous 8 s (`STEP_TIMEOUT_MS`), il
   abandonne.
2. Puis `reveal()`, **quoi que montre l'écran**. Rien ne compare l'écran live à la capture.

## Hypothèses, de la plus probable à la moins probable

1. **Session restaurée.** Le runtime web garde l'historique et les champs dans
   `localStorage` (`luciole:session:<app>:<server>`, `web/platform/run.tsx`) : une deuxième
   visite rouvre la dernière route du lecteur, pas celle de la capture. Le hero et la
   galerie font tourner **la même app Forge** : même clé de session, même SharedWorker,
   même base OPFS. Naviguer dans l'un change ce que l'autre rouvre. Le script saute en
   avant ou abandonne, et révèle un autre écran.
2. **Course dans le script.** Les `pause` (250 ms) supposent que le rendu a suivi. Sur une
   machine chargée : « forge » tapé avant que le champ PIN n'ait le focus (connexion
   ratée), ou `j` pas encore appliqué quand ⏎ part, ce qui ouvre web#1 au lieu de
   payments#1. Le but n'apparaît jamais, et 8 s plus tard, révélation sur le mauvais écran.
3. **Données persistées.** OPFS garde les bases entre visites : notes modifiées dans
   Latency, commentaires ou approbations dans Forge, conversations Chat qui s'accumulent.
4. **Révélation trop tôt.** Le texte du but apparaît avant la fin du rendu (Suspense,
   streaming Flight, checks CI qui arrivent, Markdown coloré après tree-sitter) : la page
   continue de changer juste après la révélation.
5. **Contenu qui dépend du moment ou du lieu.** Dates de mdreader dans la langue du
   navigateur, âges relatifs, « just now », temps de la waterfall DevTools.

## Pistes de correction (à valider)

- **Révéler sur correspondance** : comparer les lignes de texte de l'écran live à celles de
  la capture (on les a : `frame.cells`), révéler dès qu'elles concordent (au moins 95 % des
  lignes, par exemple), sinon au délai, et journaliser l'écart en dev.
- **Une session par démo embarquée** : une `sessionKey` distincte pour le hero et la
  galerie (le runtime en a déjà la notion, `PageOptions.sessionKey`, à exposer par l'URL),
  ou pas de restauration pour une démo embarquée.
- Des étapes qui attendent un état observable plutôt qu'une pause (un texte unique,
  l'élément sélectionné).
- Pour les données : accepter la persistance (c'est une fonctionnalité, Notes la montre),
  ou repartir d'une base propre par visite pour les démos qui ont un script.

## Reproduire et mesurer

```sh
bun install --frozen-lockfile && (cd website && bun install --frozen-lockfile)
cd website && bun run demo    # public/demo/ (ignoré par Git) ; runtime web : Zig 0.16.0 (installé)
bun run dev --port 4400       # 4321 est pris par un `astro preview` + tunnel Cloudflare
```

- Piloter Chrome : `scripts/web/cdp.ts` (`Browser.start()`, `open`, `evaluate`, `waitFor`,
  `press`, `insertText`, `click`, `screenshot`). Chaque `Browser.start()` prend un profil
  neuf : pour reproduire une **deuxième visite**, garder le même `Browser` et recharger.
- Lire l'écran live : `iframe.contentDocument.querySelectorAll(".xterm-rows > div")`, et
  celui du poster : `[data-live] .stand .xterm-rows > div`.
- Comparer au pixel : Page.captureScreenshot avec `clip` en coordonnées **du document**
  (`rect.y + scrollY`). Piège déjà rencontré : un `clip` en coordonnées du viewport
  compare des zones vides.
- Un test de non-régression serait bienvenu (`scripts/web/`, sur le modèle de
  `forge.ts` / `embed.ts`) : poster puis live, deux visites, lignes comparées.

## Conventions

Réponses en français ; commits en anglais selon `~/.claude/rules/git-commits.md` (le
pourquoi, fix = symptôme / cause / solution). Pas d'`as`, pas de `!`, Zod pour les données
externes (`postMessage` compris), constantes nommées (`no-magic-numbers`). Avant de
conclure : `bun run check && bun run lint && bun run format:check`, `(cd website && bun run check)`,
et les parcours `bun run test:web:embed`, `test:web:forge`, `test:web:local`, `test:web`.
Ne pas pousser ni fusionner dans `main` sans le demander.
