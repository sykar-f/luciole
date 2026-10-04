# API applicative minimale

Entrée `@luciole-sh/core/client` (Client Components uniquement) :

| API                                                                                                                                    | Contrat                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useNavigate()`, `useRouter()`, `useRouterState()`, `useParams()`, `useSearch()`, `useLocation()`, `useMatchRoute()`, `useCanGoBack()` | Primitives TanStack Router réexportées telles quelles ; TanStack est l'unique état de navigation.                                                          |
| `useApplication()`                                                                                                                     | `{ setToken(token?), refresh(), invalidate(paths?), cancel(), withSignal(signal, call), onEvent(listener), status, error }` du runtime terminal.           |
| `<Input name? value onInput />`, `<Textarea name? value onChange />`                                                                   | `input` et `textarea` d'OpenTUI, contrôlés ; un `name` rend leur texte restaurable (voir « Champs restaurables »).                                         |
| `useRestoredFields(group)`                                                                                                             | `{ submit(action, { failed? }?), clear() }` des champs `group/…` de l'entrée d'historique courante.                                                        |
| `useRestoredFocus(names)`                                                                                                              | `[focus, setFocus]` : lequel de `names` a le focus, gardé par entrée d'historique.                                                                         |
| `<ScrollBox name? …>`                                                                                                                  | `scrollbox` d'OpenTUI ; un `name` garde sa position de défilement par entrée.                                                                              |
| `useConnection()`                                                                                                                      | `{ status, error, buildError, activity, refresh }` pour le chrome de l'application ; `activity` vaut `connect`, `navigate`, `refresh` ou `idle`.           |
| `useInvalidation(listener)`                                                                                                            | Appelé à chaque invalidation (Server ou Client) avec les chemins et les tags : pour les données lues hors des loaders de routes.                           |
| `useLive(source, args, { limit }?)`                                                                                                    | `{ items, done, error }` d'une Server Function génératrice, abonnée tant que le composant est monté.                                                       |
| `useBindings()`, `useActiveKeys()`, `useKeymap()`, `usePendingSequence()`                                                              | Keymap OpenTUI réexportée : couches de raccourcis liées au cycle de vie des composants.                                                                    |
| `<KeyHelp groups? inline? />`                                                                                                          | Aide générée depuis les raccourcis actifs qui déclarent un `desc` (filtrés par `group`).                                                                   |
| `<Embed app name active prefix? />`, `openApplication({ bundle, url, instance? })`                                                     | Une autre application luciole dans un pane de celle-ci ; voir « Applications embarquées ».                                                                 |
| `<Markdown content streaming syntaxStyle onLink? imageBase? />`                                                                        | Markdown rendu par blocs : pendant que `content` s'écrit (`streaming`), le texte affiché ne bouge plus ; voir « Markdown en streaming ».                   |
| `<Terminal command active prefix? cwd? env? onExit? />`                                                                                | Un programme local (shell, vim, un Client luciole) sur un PTY, rendu dans l'arbre ; voir « Terminaux embarqués ».                                          |
| `<TerminalView program label spawn active prefix? onExit? />`                                                                          | Comme `<Terminal>`, mais l'hôte démarre lui-même le programme (`spawn(io)` : un Client confiné par `@luciole-sh/core/sandbox`, un arrêt autre que SIGHUP). |
| `host`, `CapabilityDenied`                                                                                                             | Ce que l'application demande à son hôte (presse-papiers, notification, URL, secret, onglets) ; voir « Capacités médiées ».                                 |
| `useHostMessage(fn)`, `useGlobalKey(key, fn)`, `useCapability(name)`                                                                   | Messages des autres onglets et touches globales tant que le composant est monté ; état `granted`, `denied` ou `prompt` d'une capacité.                     |
| `<DebugOverlay limit? />`                                                                                                              | Requêtes, requêtes ouvertes, octets, dernier RTT et derniers événements depuis son montage.                                                                |
| `instrumentTracing(app, tracer)`                                                                                                       | Un span par requête vers un `Tracer` OpenTelemetry (ou compatible) ; renvoie la fonction d'arrêt.                                                          |
| `TransportError`, `BuildMismatch`, `AuthenticationRequired`                                                                            | Échecs de transport typés ; `outcome` vaut `not-sent`, `rejected` ou `unknown`.                                                                            |
| `LayoutProps`, `LoadingProps`, `ErrorProps`, `NotFoundProps`                                                                           | Props des fichiers `layout.tsx`, `loading.tsx`, `error.tsx` et `not-found.tsx` (voir plus bas).                                                            |

Le framework ne possède aucun état métier : ni Draft, ni opération en attente, ni
politique de reprise. Il rapporte ce qui est arrivé à chaque requête ; l'application
décide. Notes et Forge conservent leurs Drafts dans leur propre `components/draft.ts`
(un store au-dessus des routes, avec `useDraft`) ; Forge ajoute `components/operations.ts`
pour les opérations qui ne sont pas des documents.

## Issue d'une requête

Toute requête qui échoue lève une `TransportError` dont `outcome` dit ce que le Server
a pu faire :

| `outcome`  | Cas                                                                                                                                          | Le Server a-t-il appelé la fonction ? |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `not-sent` | Connexion refusée, hôte injoignable, annulation avant l'envoi                                                                                | Non                                   |
| `rejected` | `4xx` : bearer absent (`AuthenticationRequired`), build différent (`BuildMismatch`), action inconnue, arguments qui ne forment pas une liste | Non                                   |
| `unknown`  | Timeout ou coupure après l'envoi, réponse perdue ou tronquée, `5xx`                                                                          | Peut-être                             |

`rejected` dit que la fonction n'a pas été appelée, pas qu'aucun code de l'application
n'a tourné : le Server exécute `authenticate` de `server/auth.ts` à chaque requête de page
ou de Server Function, avant de vérifier le build.

Le transport ne prétend jamais une certitude qu'il n'a pas : tout cas non reconnu vaut
`unknown`. Une exception levée par une Server Function répond un `500` générique
(« Server request failed ») : ni message, ni stack, ni chemin ne quittent le Server.
Une erreur de rendu Server qui porte un `digest` Flight n'est pas une erreur de
transport : elle arrive telle quelle à `error.tsx`.

L'erreur remonte telle quelle jusqu'au code qui a appelé la Server Function. Le
framework ne réessaie jamais. Rejouer, consulter un registre, marquer l'opération
inconnue ou seulement afficher un message relève de l'application. Le motif de Notes est
un choix applicatif : une opération inconnue est d'abord consultée par son identifiant ;
si le Server n'en a aucune trace, Notes la renvoie avec le même identifiant, que le
repository n'applique qu'une fois. Le premier envoi :

```tsx
try {
  draft.confirm(await saveNote(snapshot));
} catch (e) {
  if (e instanceof TransportError && e.outcome !== "unknown") draft.fail(e.message);
  else draft.markUnknown(); // Ctrl+O consulte le résultat, puis renvoie au besoin
}
```

`setToken(token)` remplace le bearer des requêtes suivantes et purge le cache de
routes (voir plus bas). Remplacer un bearer (déconnexion, autre compte) oublie aussi le
texte des champs restaurables ; la première connexion d'un Client le garde, pour que le
texte restauré après un crash survive à la connexion qu'il demande. Il ne touche à aucun
état applicatif : une application qui change d'identité vide elle-même ses Drafts et
opérations, au moment où elle appelle `setToken`. Un `401` sur une Server Function n'entraîne aucune navigation :
`AuthenticationRequired.loginPath` indique où se connecter.

## Invalidation déclarée par le Server

Une Server Function déclare ce qu'elle a changé ; le Client revalide après la réponse,
sans attendre ni échouer avec ce refresh :

```ts
"use server";
import { invalidate } from "@luciole-sh/core/server";

export async function merge(target: Target) {
  const result = forge.merge(actor(), target);
  if (result.ok) invalidate(); // "/" par défaut : toutes les routes
  return result;
}
```

`invalidate("/repos/web")` revalide `/repos/web` et ses descendants, jamais un simple
préfixe (`/repos/website`). `invalidate({ tag })` purge les résultats `"use cache"` de ce
tag et revalide seulement les routes qui l'ont lu ([CACHE.md](CACHE.md)). L'invalidation
voyage dans l'enveloppe de la réponse : une
réponse perdue n'invalide rien. Les lectures faites par Server Function hors des
loaders (compteurs d'un chrome) s'abonnent avec `useInvalidation`. Le code Client
peut aussi appeler `useApplication().invalidate(paths?)` après un changement qu'il
observe lui-même.

## Abonnements live

Une Server Function génératrice (`export async function*` dans un module
`"use server"`) livre ses valeurs au fil de l'eau. `useLive` ouvre la requête au
montage (ou quand ses arguments changent) et l'annule au démontage ; le Server arrête
alors le générateur (son `finally` s'exécute).

```tsx
const { items, done, error } = useLive(checkLog, [check.id], { limit: 500 });
```

Rien ne se reconnecte tout seul : une coupure termine le flux avec une
`TransportError` (`unknown`). Une réponse live échappe au délai d'inactivité du
Server. `useApplication().withSignal(signal, () => action(...))` lie un signal
d'annulation à n'importe quel appel de Server Function.

## Raccourcis clavier

`Shell` installe la keymap par défaut d'OpenTUI (`@opentui/keymap`). Le framework ne
déclare que `ctrl+c` (quitter) et, pendant une navigation, `escape` (annuler), dans le
groupe `luciole`. Dans une fenêtre desktop (`LUCIOLE_DESKTOP=1`, option
`quitOnCtrlC: false`), `ctrl+c` n'est plus déclaré : on quitte en fermant la fenêtre
([DESKTOP.md](DESKTOP.md)). Tout le reste appartient à l'application :

```tsx
useBindings(
  () => ({ bindings: [{ key: "ctrl+s", cmd: save, desc: "save", group: "note" }] }),
  [save],
);
// …
<KeyHelp inline groups={["note"]} />;
```

Une couche vit avec son composant : quitter une page retire ses raccourcis et leur
aide. `useKeyboard` d'OpenTUI reste utilisable à côté.

## Applications embarquées

`<Embed>` montre une autre application luciole dans un pane de celle-ci, dans le même
processus et le même arbre React : le mode `inline` de [EMBEDDING.md](EMBEDDING.md),
sans isolation (confiance totale).

```tsx
const app = await openApplication({ bundle: "…/mdreader/.luciole/app", url });
<Embed app={app} name="docs" active={pane === "docs"} prefix="ctrl+o" flexGrow={1} />;
```

- `openApplication` lit le **bundle d'application** (`.luciole/app/`, produit par
  `luciole build`) : ses Client Components, son route tree et ses stubs de Server
  Functions, sans runtime. Il vérifie sa clé d'ABI et son hash, puis l'évalue **une fois
  par pane** contre le runtime de l'hôte (ses modules et la liaison de ses Server
  Functions lui sont propres, React, OpenTUI, le routeur et le keymap sont ceux de
  l'hôte). Il lui donne une clé d'instance (`x-luciole-instance`) et ouvre sa connexion
  (`http`, `unix:`, `ssh://`, comme `--url`). Un bundle construit pour une autre ABI, un
  fichier modifié ou un `require` hors ABI et hors built-ins déclarés sont refusés. Un
  manifeste signé (`luciole build --sign-bundle`) est vérifié ; une signature invalide est
  refusée. `publisher: { required?, trust? }` exige une signature et reçoit l'empreinte
  de la clé avant toute évaluation (l'épinglage par origine du Client générique).
- `active` : seul le pane actif entend les touches, et ses raccourcis globaux avec. Un
  pane inactif ne garde rien de focalisé : ce qui avait le focus le retrouve quand il
  redevient actif.
- `prefix` : comme pour `<Terminal>`, la touche de l'hôte et la séquence qu'elle ouvre
  restent aux raccourcis de l'hôte, même si l'application lie la même touche. Une seule
  touche bascule entre terminaux et applications.
- Une erreur de rendu dans le pane s'affiche dans le pane et n'atteint jamais la racine.
- `app.dispose()` libère un pane fermé : requêtes et flux live arrêtés, modules
  désenregistrés, connexion fermée (`onDispose`). `app.quit`, que `run()` règle pour
  un Client seul, est à l'hôte : `examples/mux` y ferme le pane (`Ctrl+C`).

## Terminaux embarqués

`<Terminal>` lance un programme local sur un pseudo-terminal (`Bun.Terminal`, POSIX
seulement) et l'affiche dans l'arbre de l'application : le mode `process` de
[EMBEDDING.md](EMBEDDING.md). Aucune isolation : le programme a les droits de
l'utilisateur, comme dans tmux. L'émulateur est l'`EmbeddedTerminalRenderable` d'OpenTUI
(libghostty-vt) ; clavier, souris, collage, rapports de focus et redimensionnement suivent
les modes demandés par le programme.

```tsx
<Terminal command={["vim", file]} active={pane === "editor"} prefix="ctrl+o" flexGrow={1} />
```

- `command` démarre au premier layout, à la taille du pane ; changer `command` relance le
  programme. `onExit(code)` signale sa fin (`null` : tué par un signal, ou introuvable, le
  message s'affiche alors dans le pane). Démonter le composant raccroche le programme
  (`SIGHUP`), et le quitter du Client aussi : le PTY fermé raccroche toute sa session.
- `active` donne les touches au terminal (il prend le focus). Pendant ce temps, il reçoit
  **toutes** les touches, `Ctrl+C` compris, avant les raccourcis de l'application : seule
  `prefix` et la séquence qu'elle ouvre restent aux `useBindings` de l'application. La
  syntaxe du keymap écrit une séquence par juxtaposition : `"ctrl+oo"` est Ctrl+O puis O.
- `scrollback` fixe le nombre de lignes gardées au-dessus de l'écran ; `id`, `flexGrow`,
  `width` et `height` placent le pane.
- L'hôte décide de la bascule (touche préfixe, clic) ; `examples/mux` en est un exemple.

`<Terminal>` sert aux programmes locaux ; une application luciole dans le même processus
passe par `<Embed>`.

## Markdown en streaming

`<Markdown>` affiche du Markdown qui arrive par morceaux, typiquement la réponse d'un
modèle, sans que le texte déjà affiché clignote ou saute. Le `<markdown>` d'OpenTUI 0.5.12
redessine son dernier bloc depuis un aperçu puis depuis Tree-sitter à chaque changement :
la réponse bascule entre texte brut et mis en forme.

```tsx
import { Markdown } from "@luciole-sh/core/client";

<Markdown
  content={reply.text}
  streaming={!reply.done}
  syntaxStyle={syntax}
  onLink={(url) => host.openUrl(url)}
  imageBase={projectDirectory}
/>;
```

- `content` ne fait que croître pendant `streaming` ; les blocs terminés sont rendus une
  fois et ne sont plus redessinés, seul le dernier l'est à chaque changement.
- Le dernier bloc est fermé d'avance (`**gras` s'affiche en gras, un lien incomplet par son
  libellé, une ligne de syntaxe seule attend son saut de ligne).
- Le texte est mis en forme sans Tree-sitter : le rendu en cours et le rendu final sont le
  même. Le code n'est coloré (Tree-sitter) qu'une fois sa clôture arrivée ; les tableaux
  s'affichent ligne par ligne.
- `syntaxStyle` : un `SyntaxStyle` d'OpenTUI ; les groupes `markup.*` (`strong`, `italic`,
  `raw`, `link`, `list`, `quote`…) stylent le texte, les autres groupes le code.
- Titres : `markup.heading.1` à `markup.heading.3` (repli sur `markup.heading`, les niveaux
  4 à 6 comme le 3). Un `bg` dessine un bandeau derrière le titre, plein sur les premières
  colonnes puis en fondu (à partir des colonnes 28, 18 et 12, fixes) jusqu'au bord droit,
  qui suit la largeur ; le fondu va vers le fond du terminal (demandé par OSC 11), et les
  dernières colonnes restent sans fond. Le H1 fait 3 lignes de haut, titre au milieu. Espacement imposé : H1 précédé de 2 lignes vides et suivi
  d'une, H2 d'une et d'une (2 au-dessus quand il clôt une sous-partie H3), H3 d'une et
  collé à son contenu. Le bandeau est peint, pas écrit : une sélection copie le titre seul.
- Blocs de code : sur le fond de `markup.raw.block` (`bg`), avec une marge intérieure et le
  langage discret en haut à droite ; sans ce `bg`, le code reste sans fond. Colorés par
  Tree-sitter une fois la clôture arrivée : OpenTUI 0.5.12 connaît JavaScript, TypeScript,
  Markdown et Zig ; `import "@luciole-sh/core/grammars"` (une fois, côté Client) ajoute Bash, C, C++,
  CSS, Go, HTML, Java, JSON, PHP, Python, Ruby, Rust, TOML et YAML, pour `<code>` et
  `<diff>` aussi. L'import est facultatif : le build copie chaque grammaire à côté du
  bundle (environ 11 Mo en tout). Les groupes de style sont ceux des requêtes Tree-sitter
  (`keyword`, `string`, `function`, `type`, `constant`, `property`, `tag`…, les noms
  pointés se repliant sur leur base). La cible web garde ces langages en texte brut.
- Blocs `diff` / `patch` : colorés ligne par ligne sans grammaire, donc dès le streaming :
  `diff.plus` (lignes `+`), `diff.minus` (`-`), `diff.delta` (`@@`), `diff.header`
  (`diff`, `index`, `---`, `+++`).
- Liens : stylés par `markup.link` (le libellé comme l'URL). Un clic (appui et relâche sur
  la même cellule, un glisser sélectionne) appelle `onLink(url)`, et le pointeur devient
  une main au survol ; sans `onLink`, seul un terminal qui dessine les liens OSC 8 peut
  les ouvrir, par son propre raccourci. `host.openUrl` n'ouvre que des URL http(s).
- Images : dessinées par `<image>` d'OpenTUI (kitty, sixel, sinon demi-blocs en couleurs),
  à la largeur disponible et sur 16 lignes au plus ; leur texte alternatif s'affiche
  pendant le chargement et reste si l'image ne se charge pas. URL http(s) et `file:`,
  chemins absolus, chemins relatifs depuis `imageBase` (un dossier ou une URL). Une image
  distante est téléchargée par le Client : l'auteur du Markdown voit la requête.
- Une réponse finie ressemble à `<markdown conceal>` .

## Capacités médiées

Ce que l'OS ne sait pas accorder à la pièce (presse-papiers, notifications, ouvrir une
URL, secrets, messages entre onglets, touches tapées ailleurs) passe par `host`, importé
d'`@luciole-sh/core/client`. Le build en donne un **par bundle**, lié à l'Application du pane comme
ses Server Functions : deux panes demandent chacun avec leur origine et leurs capacités.

```tsx
import { CapabilityDenied, host, useCapability } from "@luciole-sh/core/client";

await host.clipboard.write(path); // rejet CapabilityDenied si l'hôte refuse
const state = useCapability("clipboard.write"); // "granted" | "denied" | "prompt"
```

- `host.clipboard.read()` / `.write(text)`, `host.notify({ title, body? })`,
  `host.openUrl(url)` (http(s) seulement), `host.secret(name)` (entrée du trousseau de
  l'origine, `undefined` si absente), `host.tabs.post(message)` / `.onMessage(fn)`,
  `host.input.onGlobalKey(fn)`. Chaque requête est validée par Zod.
- Qui répond : un Client autonome ou un pane `inline` exécute lui-même, avec les droits de
  l'utilisateur (`pbcopy`, `osascript`, `open`, `security`) ; tout y est `granted`. Un
  Client en mode `sandbox` demande à l'hôte par IPC, qui vérifie la capacité accordée à
  l'origine, demande à l'utilisateur si elle n'est pas décidée (`prompt`), puis exécute.
- Hooks, sur le même canal que le `host` du pane : `useHostMessage(fn)` et
  `useGlobalKey("ctrl+s", fn)` se désabonnent au démontage ; `useCapability(name)` re-rend
  quand l'utilisateur accorde ou refuse. Pas de `useHost()` : `host` est l'API de base.
- Une séquence OSC 52 écrite par une application sandboxée n'atteint jamais le
  presse-papiers : seule la voie `host` est vérifiée. Sous Linux, seccomp refuse à
  l'application tout socket Unix (D-Bus, Wayland, X11) : la voie `host` est la seule.
- Mécanisme selon le système (`luciole <url>`) : Seatbelt (macOS) ; `luciole-sandbox` avec
  espaces de noms, ou sous bubblewrap (Linux), par défaut ; Landlock seul (réseau non
  confiné par hôte) seulement avec `--sandbox`. L'écran des capacités nomme le mécanisme.

## Arguments de l'application

Une application déclare ses options de ligne de commande dans `app/args.ts` (facultatif),
avec `defineArgs` de `@luciole-sh/core/args` et un schéma zod 4 — plus généralement tout Standard
Schema qui implémente aussi Standard JSON Schema :

```ts
// app/args.ts
import { defineArgs } from "@luciole-sh/core/args";
import { z } from "zod";

export default defineArgs({
  summary: "Coding agent client",
  options: z
    .object({
      harness: z.enum(["claude", "codex"]).optional().meta({ short: "H" }),
      cwd: z.string().optional().meta({ kind: "path", placeholder: "DIR" }),
      mode: z.enum(["read", "ask"]).default("ask"),
      resume: z
        .union([z.literal(true), z.string()])
        .optional()
        .meta({ placeholder: "ID" }),
    })
    .strict(),
  examples: ["coder -H codex --resume"],
});
```

La grammaire vient du JSON Schema des options (propriété camelCase → `--kebab-case`) :

| Schéma               | Ligne de commande                                                   |
| -------------------- | ------------------------------------------------------------------- |
| booléen              | `--flag`, `--no-flag`                                               |
| chaîne, enum, nombre | `--flag v`, `--flag=v` (nombres convertis avant validation)         |
| `true \| string`     | `--flag` seul, ou `--flag v` si le mot suivant n'est pas une option |
| tableau de scalaires | répétable : `--flag a --flag b`                                     |

`.meta()` ajoute `short` (une lettre, `-abc` groupe les booléens), `placeholder`,
`description`, `kind: "path"` (résolu contre le répertoire où la commande a été tapée) et
`env` (variable lue quand l'option est absente : ligne de commande > variable > défaut).
Un objet imbriqué ou une autre union est refusé au build. Une erreur d'usage nomme
l'option, propose la plus proche (« did you mean ») et sort avec le code 2. `--help` est
généré : options de l'application, puis options du runtime, puis exemples.

Les options du runtime sont réservées ; le build refuse une application qui déclare
`--url --on --target --grace --yes --help -h --version --new`.

Côté Server, la valeur est typée par l'import, sans génération de code :

```ts
import "server-only";
import cli from "../app/args";
export const config = cli.get(); // { harness?: "claude" | "codex"; mode: "read" | "ask"; … }
```

`getArgs()` (`@luciole-sh/core/server`) rend la même valeur, non typée, et `getLaunch()` le
lancement : `{ scope, id?, cwd }`, où `scope` est `luciole.server` du `package.json`
(`shared`, `per-directory` ou `per-launch`, voir
[DISTRIBUTION.md](DISTRIBUTION.md#qui-partage-un-server--lucioleserver)). Le Server fait autorité : il
reparse lui-même la ligne reçue avant de servir, et une ligne refusée l'arrête (code 2,
message dans son log). **Un Server = un jeu d'arguments** : `get()` est une constante du
process, sûre au niveau module, dans un singleton ou sous `"use cache"`. Il n'y a pas
d'API Client : `get()` lève côté Client, la page passe en props ce dont l'UI a besoin
(avec `--url`, un Client générique ou le web, le Client n'a de toute façon pas
d'arguments). `app/args.ts` tourne dans le lanceur, le binaire et le Server : il ne peut
importer ni `server-only`, ni `client-only`, ni `server/`, ni OpenTUI.

Chaque point d'entrée qui démarre un Server accepte les options, les vérifie avant de le
démarrer et les lui transmet par la variable `LUCIOLE_ARGS` (`{v, argv, cwd}`), jamais par
sa ligne de commande que `ps` montre aux autres utilisateurs :

| Entrée                                            | Options de l'application                                                                     |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `luciole dev --app d -- <options>`                | après `--` ; revérifiées à chaque rebuild                                                    |
| `luciole ./app <options>`, source git             | tout ce qui n'est pas `--url`, `--grace`, `--yes`, `-h`                                      |
| binaire `app <options>`                           | tout ce qui n'est pas une option du runtime                                                  |
| `app serve [--http … \| --socket …] -- <options>` | après `--`                                                                                   |
| `app --on host <options>`                         | envoyées sur l'entrée standard du `serve --detach` distant ; les chemins se résolvent là-bas |
| `luciole start --role server -- <options>`        | après `--`                                                                                   |
| `--url`, `luciole connect`, Client générique      | refusées : ce Client rejoint un Server qui tourne déjà                                       |

Le build bundle `app/args.ts` dans `.luciole/args/` (le lanceur et le binaire l'importent)
et écrit son JSON Schema dans `.luciole/metadata.json` (`args`), qu'un hôte lit sans
exécuter l'application.

## Métadonnées de l'application

Ce que les hôtes montrent d'une application sans l'exécuter (une fenêtre desktop, son
bundle, une liste d'apps) se déclare dans le champ `luciole` de son `package.json`, à côté
de `capabilities` :

```jsonc
{
  "version": "0.1.0", // du paquet : version du bundle desktop
  "description": "A personal notebook: notes kept in SQLite on the Server.",
  "luciole": {
    "displayName": "Notes", // titre de fenêtre, menu, Dock ; le nom du répertoire sinon
    "identifier": "dev.luciole.examples.notes", // DNS inversé : identifiant du bundle macOS
    "icon": "assets/icon.png", // PNG carré, 512 px ou plus (1024 pour le Retina)
  },
}
```

Le build vérifie la déclaration avant de construire (une icône absente, trop petite ou
hors du répertoire l'arrête aussitôt) et écrit `.luciole/metadata.json`, valeurs par
défaut appliquées, avec `.luciole/icon.png` à côté. Un hôte lit cette sortie, jamais les
sources : `AppMetadata` (`@luciole-sh/core/metadata`, `src/app-metadata.ts`) en est le schéma.
`name` reste le nom du répertoire, qui nomme binaires, sessions et sockets ; seul
`displayName` est fait pour être lu.

## Observabilité

`useApplication().onEvent(listener)` reçoit chaque événement de transport
(`request`, `response`, `chunk`, `end`, `error` avec son `outcome`) et chaque
navigation résolue. `<DebugOverlay />` les résume à l'écran ; `instrumentTracing`
les exporte en spans OpenTelemetry sans dépendance du framework à OTel (le `Tracer`
est typé structurellement). Les écouteurs s'exécutent sur le chemin chaud : ils
doivent rester légers.

Chaque événement porte `at` (epoch ms, horloge monotone : `performance.timeOrigin +
performance.now()`). Ceux du transport portent aussi `callId`, envoyé au Server en
`x-luciole-call` sur `/render` comme sur `/action` ; le Server le retrouve dans
`getCallId()` et dans ses `ServerEvent`. `request` porte sa
`cause`, déterminée au mieux par le Client : `navigation`, `preload`, `refresh`,
`invalidation`, `action`, `live`, sinon `unknown`. Un `Transport` la reçoit en dernier
argument de `render`/`call` (`{ cause }`). S'y ajoutent :

| Événement    | Champs                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------ |
| `navigation` | `path`                                                                                                       |
| `invalidate` | `paths`, `origin` (`server` : `invalidate()` d'une Server Function ; `client` : `invalidate()`, `refresh()`) |
| `loader`     | `phase` (`start`, `end`), `routeId`, `href`, `cause` ; à la fin `ms` et `result` (`ok`, `error`, `aborted`)  |
| `failure`    | `path`, `message` : une page a échoué (chargement ou rendu) ; son écran d'erreur l'émet (`reportFailure`)    |

`invalidate` porte aussi `tags`, et `loader` sa `source` (`network`, `router-cache`) :
voir [CACHE.md](CACHE.md).

`<DebugOverlay />` ignore `invalidate`, `loader` et `failure` ; `instrumentTracing` aussi.

Un Client lancé avec un canal IPC (`luciole dev`, un hôte `sandbox`, studio) envoie chaque
`failure` à son parent : `{ type: "failure", path, message }` (message coupé à
2000 caractères). `onClientFailure(child, listener)` d'`@luciole-sh/core/dev` le lit, `openSandbox`
le passe à `onFailure`. Une page introuvable (`notFound()`) n'est pas un échec.

En développement, `LUCIOLE_DEVTOOLS=<adresse>` envoie ces événements, ceux du Server, les
logs des deux processus et l'arbre des composants à `luciole devtools`, lancé dans un autre
terminal ; sans la variable, rien n'est chargé. Voir [DEVTOOLS.md](DEVTOOLS.md).

## Champs restaurables

Le Client joue le rôle du navigateur, il garde donc ce qu'un navigateur garde d'une
session : **l'historique, et le texte tapé dans les champs nommés de chacune de ses
entrées**. Rien d'autre : les données de page reviennent du Server en naviguant, le
token reste à l'application, un champ sans `name` n'est jamais écrit (un PIN, un mot de
passe).

| Quand                                                   | Ce qui revient                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| Retour sur une entrée d'historique (`u`, back)          | Le texte des champs nommés de cette entrée                         |
| Rebuild de `luciole dev`                                | La page, l'historique, les champs nommés et le bearer (en mémoire) |
| Crash, `kill -9`, terminal fermé, SSH coupé (SIGHUP)    | La page, l'historique et les champs nommés, au prochain lancement  |
| SIGTERM (arrêt de la machine), fenêtre desktop comprise | La page, l'historique et les champs nommés, au prochain lancement  |
| Ctrl+C ou `app.quit()` : sortie volontaire              | Rien : la session est supprimée, comme un navigateur fermé exprès  |
| Fenêtre desktop fermée (SIGHUP sous `LUCIOLE_DESKTOP`)  | Rien : fermer la fenêtre, c'est quitter l'application              |

- **Par entrée d'historique**, comme un navigateur : rouvrir la même page par un lien
  crée une nouvelle entrée, vide. Garder un texte par document, quel que soit le
  chemin (les Drafts de Notes et Forge), reste une politique applicative.
- **Un champ appartient à l'entrée où il a été monté** : un champ d'un layout persistant
  continue d'écrire dans l'entrée où il est apparu.
- **Restaurer, c'est retaper** : au montage, un champ dont l'entrée garde un texte
  appelle une fois `onInput` (ou `onChange`) avec ce texte. L'état de l'application ou de
  sa bibliothèque de formulaires le reçoit par le même chemin que la frappe, donc comme
  un travail non enregistré. Un texte n'est gardé que s'il a été tapé ; une valeur posée
  par l'application (une remise à zéro) ne fait que suivre un texte déjà gardé.
- **Focus et défilement**, par entrée aussi, sur demande : `useRestoredFocus(noms)` est
  l'état de focus de l'application (`[focus, setFocus]`, le premier nom tant que
  l'utilisateur ne l'a pas déplacé ; un nom gardé qui n'est plus dans la liste donne le
  premier), et `<ScrollBox name>` une `scrollbox` dont la position revient. Cette position
  attend, un moment après le montage, que le contenu soit assez haut (une liste chargée
  ensuite) ; un défilement de l'utilisateur entre-temps l'emporte. Changer de bearer
  n'oublie que le texte tapé.
- **Un groupe** réunit les champs `groupe/champ`. `useRestoredFields("groupe").submit(action)`
  oublie leur texte _avant_ la requête, pour qu'un crash pendant l'envoi ne le propose
  pas de nouveau (pas de double envoi). Si l'issue prouve que rien n'a tourné
  (`not-sent`, `rejected`), ou si `failed(résultat)` dit que le Server a refusé, le texte
  est gardé de nouveau, sauf si l'utilisateur a tapé plus récent entre-temps. `clear()`
  l'oublie sur demande (abandon).
- **Stockage** : un fichier par Client (comme un onglet), en `0600`, dans
  `$XDG_STATE_HOME/luciole/<app>/sessions/` (`~/.local/state/…`), écrit 200 ms après la
  dernière modification et avant de sortir sur un signal. Après un crash, le Client
  suivant reprend la session la plus récente laissée par un Client mort pour la même
  adresse de Server, jamais celle d'un Client vivant. Au plus 50 entrées ; un champ de
  plus de 100 000 caractères n'est pas gardé ; une session orpheline est supprimée
  après 7 jours. Le texte n'est pas chiffré.
- **Comptes** : remplacer un bearer oublie tous les champs (voir `setToken`). Un autre
  compte qui se connecte en premier après un crash retrouve le texte du précédent : la
  session appartient à l'utilisateur du système, comme un profil de navigateur.

`Textarea` rend contrôlé le `textarea` d'OpenTUI, qui ne l'est pas (`initialValue`
seulement) : `value` en entrée, `onChange` en sortie, comme l'`input`. Une valeur posée
de l'extérieur remplace le contenu et place le curseur à la fin.

### Avec une bibliothèque de formulaires

Le framework ne valide ni n'envoie de formulaire. Les bibliothèques qui pilotent un
champ par valeur et callback fonctionnent telles quelles, par leur chemin « React
Native ». TanStack Form est celle que suivent les exemples (formulaire de nouvelle pull
request de Forge, `components/NewPullForm.tsx`) :

```tsx
"use client";
import { useField, useForm } from "@tanstack/react-form";
import { Input, Textarea, useRestoredFields } from "@luciole-sh/core/client";
import { publish } from "../actions/posts";

export function NewPost() {
  const fields = useRestoredFields("post");
  const form = useForm({
    defaultValues: { title: "", body: "" },
    // Le texte gardé est oublié pendant la requête, gardé de nouveau si elle échoue sans
    // avoir tourné ou si le Server refuse.
    onSubmit: ({ value }) => fields.submit(() => publish(value), { failed: (r) => !r.ok }),
  });
  const title = useField({
    form,
    name: "title",
    validators: { onSubmit: ({ value }) => (value.trim() ? undefined : "Title required") },
  });
  const body = useField({ form, name: "body" });
  return (
    <box flexDirection="column">
      <Input name="post/title" value={title.state.value} onInput={title.handleChange} />
      <text>{title.state.meta.errors.join(" · ")}</text>
      <Textarea name="post/body" value={body.state.value} onChange={body.handleChange} />
    </box>
  );
}
```

Un raccourci (`useBindings`, Ctrl+S) appelle `form.handleSubmit()` : pas de `<form>`, le
terminal n'en a pas. Les champs passent par `useField` plutôt que `<form.Field>` : le
namespace JSX d'OpenTUI ne déclare pas `ElementType`, et TypeScript refuse un composant
typé pour renvoyer `ReactNode | Promise<ReactNode>` (le code s'exécute, seul le contrôle
de types échoue). React Hook Form fonctionne avec `useController` (son `register()`
attend un événement DOM et échoue) ; Formik avec `useFormik` et `handleChange("champ")`,
jamais ses composants `<Form>` et `<Field>`, qui rendent du HTML.

## Serveur et intégration

Entrée `@luciole-sh/core/server` :

- `getSession()` : `{ userId }` dans le contexte async du rendu ou de l'action.
- `getOptionalSession()` : la session de la requête, ou `null` pour une requête anonyme ;
  une page ou une action publique reçoit aussi la session d'un utilisateur connecté.
- `getCallId()` : identifiant de requête de transport, distinct de l'opération métier.
- `notFound(what?)` : termine le rendu d'une page avec le `not-found.tsx` le plus proche.
- `invalidate(path?)` : dans une Server Function, déclare les routes à revalider.
  `invalidate({ tag })` : purge un tag de cache (`Promise<void>`), partout côté Server ;
  seule une Server Function prévient aussi son Client.
- `cacheLife(profil | durées)`, `cacheTag(...tags)`, `memoryCache()`, `sqliteCache({ path })`,
  types `CacheHandler`, `CacheEntry`, `CacheEvent` : cache `"use cache"`, voir [CACHE.md](CACHE.md).
  `getSession()` et `getOptionalSession()` lèvent dans une fonction cachée.
- `serve({ …, instrument? })` : `instrument.onEvent(event)` reçoit un `ServerEvent` pour
  chaque `/render` et `/action` : `request`, `response` (`status`, `ms`), `end` (`bytes`,
  `cancelled`, à la fin du corps, live compris) ou `error` (exception d'un handler, avant
  le `500` générique), avec `callId`, `kind`, `target` (routeId ou id d'action) et `at`.
  Sans `instrument`, aucune réponse n'est enveloppée. S'y ajoutent les `CacheEvent`
  (`type: "cache"`) de `"use cache"`. C'est aussi l'emplacement des
  futurs middlewares (commentaire dans `createHandler`) ; le build ne le passe pas encore.
  `/action` répond `Server-Timing: total;dur=…` (jusqu'au retour de la fonction, donc
  au modèle racine). `/render` n'en a pas : la page se rend dans le flux, après les
  en-têtes. Son modèle racine est `{ tree, tags }` ([CACHE.md](CACHE.md)).

`LUCIOLE_SOCKET=/chemin` fait écouter `serve()` sur ce socket Unix (0600) plutôt qu'en
TCP ; la ligne `ready` nomme alors `socket`. Côté Client, `--url unix:/chemin` s'y
connecte. `run(create, { name, sessionKey })` (ou `LUCIOLE_SESSION_KEY`) range les sessions
restaurables sous cette clé plutôt que sous l'URL. C'est ainsi que le lanceur démarre une app locale ([DISTRIBUTION.md](DISTRIBUTION.md)).

Le framework ne rafraîchit rien de lui-même après une Server Function : une lecture
(`getOperation`, identité publique, recherche) ne coûte aucun rendu de page.

Les arguments d'une Server Function arrivent décodés par Flight mais **non vérifiés** :
son type TypeScript décrit ce que le Client est censé envoyer, pas ce qui arrive. Le
framework garantit seulement une liste d'arguments (`ServerFunction` les type
`unknown[]`) ; la fonction valide les siens avant tout effet, comme le font Notes et
Forge avec Zod. Une fonction qui refuse ses arguments lève une exception : la réponse
est un `500` et l'appelant voit `unknown`, car le framework ne peut pas savoir qu'aucun
effet n'a eu lieu avant le refus. Le framework valide ce qu'il reçoit lui-même : variables
d'environnement du Server et du Client au démarrage (une valeur invalide arrête le
processus en nommant la variable), `luciole.json`, params et search de `/render`,
enveloppe d'une réponse d'action côté Client (sinon `TransportError`, `unknown`).

Les fonctions `createApplication`, `Shell`, `serve` et `build` servent au CLI,
aux tests et aux intégrateurs du framework. Le résolveur de modules est une fonction
`(moduleId) => exports`, injectée dans `createApplication`. Le registre de modules du
codec Flight est indexé par clé d'instance (`instance`, `x-luciole-instance`) : plusieurs
Applications partagent un processus Client, chacune avec ses modules (voir
« Applications embarquées »). Aucun chargement de chunks distants.
`createApplication({ session })` restaure un historique et ses champs (ce que `run()`
relit sur disque) ; `app.restoration.snapshot()` donne la session courante, ce qui permet
de simuler un redémarrage dans un test. `app.onTokenChange(listener)` sert au
superviseur de `luciole dev` pour transmettre le bearer au Client relancé.

Le transport est une interface remplaçable (`src/transport.ts`), injectable via
`createApplication({ transport })` :

```ts
interface Transport {
  render(
    routeId: string,
    params: RouteParams,
    signal: AbortSignal,
    search?: RouteSearch,
    context?: RequestContext, // { cause?, onTags? }
  ): Promise<ReactNode>;
  call(
    actionId: string,
    args: unknown[],
    signal?: AbortSignal,
    context?: RequestContext,
  ): Promise<unknown>;
  setToken(token?: string): void;
}
```

L'adapter par défaut `createHttpTransport` porte l'en-tête de build, le bearer, le
timeout, la latence simulée (`latencyMs`, `network`), les erreurs typées, les
événements (`onEvent`), l'invalidation (`onInvalidate`) et le décodage Flight
progressif. Le runtime et les tests utilisent aussi des transports factices.

`ApplicationOptions.transport` remplace ce transport ; `wrapTransport(inner)` le
décore (cache, enregistreur, rejeu) depuis un module séparé, sans toucher au runtime :

```ts
createApp({
  wrapTransport: (inner) => ({ ...inner, render: (...a) => cached(a) ?? inner.render(...a) }),
});
```

Le décorateur voit chaque `render` et `call` ; ce qu'il lève arrive tel quel à
l'application : il doit laisser passer les `TransportError` et leur `outcome`.

## Entrées d'intégration

Pour le CLI, les hôtes, le code généré et les tests ; une application n'en a pas besoin.

| Entrée                        | API                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@luciole-sh/core/client`     | `Application` (construite par `createApplication(options)`), `ApplicationOptions`, `ApplicationEvent` (ce que reçoit `onEvent`), `Shell({ app })`, `run(create, { name?, sessionKey? })` et `RunOptions`, `createActions()` (Server Functions et `host` d'une évaluation de bundle, émis par le build). Types `LiveState`, `TracerLike`, `Session` (`{ index, entries }`), `SessionEntry` (`{ href, fields }`), `OpenApplicationOptions`, `PublisherCheck` (`{ required?, trust?(fingerprint, manifest) }`), ceux du transport et de `host`.                  |
| `@luciole-sh/core/server`     | `createHandler(config, options)` : le Server comme fonction d'une `Request`, sans écoute ; `serve(config)` l'installe sur `Bun.serve`. `ServerConfig` : `buildId`, `manifest`, `actions`, `routes` (`ServerRoute`), `auth?`, `instrument?` (`ServerInstrument`, `{ onEvent }`), `cache?`, `appBundle?`, `web?`. `HandlerOptions` : `auth`, `devtools?`, `testing?`, `web?`, `keepAlive?`, `dropAfterCommit?`. Types `RouteAuth` (`"public" \| "required"`), `Session`, `ServerFunction`, `ServerEvent`.                                                       |
| `@luciole-sh/core/route-tree` | Ce qu'appelle `app/routeTree.gen.ts` : `rootRoute(Layout, NotFound?)`, `layoutRoute(Layout, params)`, `pageRoute(params, { loading?, error?, notFound?, splat? }?)`, `loadPage(ctx, routeId, params, splat?)`, `validateSearch(raw)` ; types `TerminalRouterContext`, `TerminalRouter` et les props des fichiers de routes.                                                                                                                                                                                                                                   |
| `@luciole-sh/core/build`      | `build(directory, output?, { appBundle?, signBundle?, webServer? }?)` → `{ buildId, output }` (`output` vaut `<directory>/.luciole` par défaut) ; `BuildOptions`. Clés d'éditeur pour `signBundle` : `generatePublisherKey(env?)`, `readPublisherKey(env?)` (fichier `LUCIOLE_PUBLISHER_KEY`), `fingerprintOf(publicKey)`.                                                                                                                                                                                                                                    |
| `@luciole-sh/core/dev`        | Superviser une app en développement, quel que soit le déclencheur du rebuild (`luciole dev`, studio) : `startAppServer({ directory, output?, env, command?, onOutput?, stderr?, timeoutMs? })` → `{ port, child, stop }` (rejette avec le stderr quand il est capté) ; `bearerRelay()` ; `serialize(task)` → `{ run, busy }` (jamais deux rebuilds à la fois, un de plus s'il en est demandé pendant) ; `linkFrameworkModules(directory, from)` ; `stopChild(child)`.                                                                                         |
| `@luciole-sh/core/sandbox`    | Le mode `sandbox` pour un hôte hors du framework ([EMBEDDING.md](EMBEDDING.md)) : `openSandbox(origin, options)` → `Sandbox` (`spawn(io)` pour `TerminalView`, `permissions`, `deliver`, `close`), `onFailure` pour les pages en échec ; `confineServer(options)` → `ServerSandbox` (`port`, `env`, `command`, `close`), macOS seulement ; `sandboxAvailability()`, `sandboxRuntime()`, `buildChild()` ; `enforcement`, `ENFORCERS`, `mechanismName` ; `Capabilities`. Le widget qui montre le Client confiné est `TerminalView` d'`@luciole-sh/core/client`. |
| `@luciole-sh/core/pty`        | `spawnPty({ command, cols, rows, env?, environment?, cwd?, ipc?, onData, onExit })` → `Pty` (`write`, `resize`, `kill`, `send`, `pid`) : `Bun.Terminal`, POSIX seulement. `<Terminal>`, le sandbox et l'hôte desktop s'en servent.                                                                                                                                                                                                                                                                                                                            |
| `@luciole-sh/core/metadata`   | `AppMetadata` (schéma de `.luciole/metadata.json`), `readAppDeclaration(root)`, `writeAppMetadata(output, declaration)`, `APP_METADATA`, `APP_ICON`.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `@luciole-sh/core/tsconfig`   | La configuration TypeScript que chaque application étend ([TOOLING.md](TOOLING.md)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Authentification des routes et actions

Les pages et les modules `"use server"` exigent une session par défaut. Une page
publique le déclare explicitement :

```tsx
export const auth = "public" as const;

export default function LoginPage() {
  return <text>Sign in</text>;
}
```

Une application qui remplace l'identité locale fournit `server/auth.ts` :

```ts
import type { AuthConfig } from "@luciole-sh/core/server";

export default {
  unauthorizedPath: "/login",
  async authenticate(request) {
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
    return token ? await sessions.fromToken(token) : null;
  },
} satisfies AuthConfig;
```

Le chemin `unauthorizedPath` doit désigner une route publique existante. Une
navigation sans session vers une route protégée reçoit un `401` puis navigue
localement vers ce chemin : c'est une règle de routage déclarée par le Server. Un
rafraîchissement de la route courante qui reçoit un `401` y va aussi. Sans
`unauthorizedPath`, une navigation atteint quand même la route protégée : son
emplacement de page montre l'erreur `AuthenticationRequired` (via le `error.tsx` le
plus proche), dans les layouts qui restent, et le statut vaut `Authentication
required`. Un rafraîchissement refusé retire l'arbre monté, alors qu'un
rafraîchissement qui échoue pour une autre raison (réseau, erreur Server, build
incompatible) le garde : après un logout (`setToken()`) sur une page protégée,
l'emplacement de page montre l'erreur, dans les layouts qui restent. Le texte non
sauvegardé que tenaient les composants de la page part avec elle : le garder
laisserait à l'écran les données du compte précédent. Une Server Function refusée ne
navigue jamais : l'erreur remonte à son appelant.

Les layouts sont des Client Components : ils ne peuvent pas appeler
`getOptionalSession()` ni `getSession()`, réservés aux pages Server, actions et
repositories. Une donnée publique de session nécessaire au chrome (nom affiché,
rôle) est rendue par la page Server ou transmise par l'application via un contexte
Client ; elle ne remplace jamais le contrôle Server.

Le guard Client n'est qu'une amélioration d'UX : chaque rendu `/render` valide
côté Server le `routeId`, les paramètres exacts attendus et la politique d'auth.
Un `routeId` inconnu répond `404`, des paramètres absents, en trop ou non textuels
répondent `400`, une page protégée sans session répond `401`.

`useApplication().setToken()` purge le cache de routes TanStack (et le purge de
nouveau à la fin d'une navigation en cours) : un arbre privé mis en cache sous un
bearer n'est jamais réaffiché sous un autre, ni après logout, et l'arbre déjà monté
part dès que son rechargement reçoit un `401` (voir plus haut). Il recharge aussi les
routes courantes sous le nouveau bearer : une navigation ou une revalidation encore
en vol, partie avec l'ancien, est remplacée et sa réponse n'est jamais affichée.
Après login/logout, l'application navigue toujours vers la route voulue.

Une action est protégée indépendamment de la page qui fournit sa référence. Pour
autoriser une Server Function sans session, placer les actions publiques dans leur
propre module :

```ts
"use server";
export const auth = "public" as const;

export async function beginLogin() {
  // Valider les arguments même sans session.
}
```

Toutes les fonctions exportées d'un même module partagent cette politique. Une
référence Flight n'accorde aucun droit, et une route protégée ne remplace jamais
les contrôles d'autorisation métier dans l'action ou le repository.

Sans `server/auth.ts`, l'adapter historique reste actif : identité `LUCIOLE_USER`
(`local` par défaut), éventuellement protégée par `LUCIOLE_TOKEN`. Le starter
reste donc compatible avec son mode local.

## Navigation, layouts et chargement local

> Remplace le contrat précédent (shell seul persistant, layout Server, machine
> d'état `useNavigation()`). Voir `docs/ROUTER.md` pour la décision et ses
> compromis.

TanStack Router (`@tanstack/react-router`, memory history, sans TanStack Start) est
l'unique autorité Client pour le route tree, le matching, les params, les layouts,
le pending, l'annulation, le cache et l'invalidation. Le build compile `app/` en
route tree code-based ; chaque page est chargée par le loader de sa route sous
forme de valeur React Flight :

```text
RouterProvider + createMemoryHistory
  └── app/layout.tsx (Client, persistant)
      └── layout.tsx imbriqués (Client, persistants)
          └── page : loader → Transport.render(routeId, params, signal) → ReactNode Flight
```

Conventions :

- `app/layout.tsx` est obligatoire ; tout répertoire peut déclarer un `layout.tsx`.
  Un layout déclare `"use client"`, exporte un composant par défaut et reçoit
  `{ children, params }` ; `children` est l'outlet des routes descendantes. Le
  build refuse un layout sans directive ou sans export par défaut.
- Un layout reste monté tant que la destination reste sous son segment : état
  local, focus et scroll survivent aux navigations entre ses pages.
- `page.tsx` reste Server par défaut et n'entre jamais dans le bundle Client.
- `(group)` n'apparaît pas dans l'URL ; avec un `layout.tsx`, il devient un layout
  pathless. Les routes statiques précèdent `[param]`. Deux pages de même URL après
  suppression des groupes, deux motifs dynamiques équivalents (`/users/[id]` et
  `/users/[slug]`), un paramètre répété ou un segment mal formé font échouer le
  build en citant les fichiers.
- `loading.tsx` (Client) devient le `pendingComponent` de chaque page qui l'hérite
  (le plus proche parmi ses répertoires parents). Il remplace **seulement** la page :
  les layouts restent affichés autour. Sans déclaration, le framework affiche
  « Connecting… » avant la première réponse, puis « Loading… ».
- `error.tsx` (Client, hérité de la même façon) remplace la page quand son chargement
  ou son rendu échoue. Il reçoit `{ error, path, params, retry }` : `error` est une
  `TransportError` (avec son `outcome`) ou une erreur de rendu Server (opaque en
  production) ; `retry()` recharge la page. Sans déclaration, le message s'affiche.
- `not-found.tsx` (Client, hérité) s'affiche quand la page appelle `notFound(what?)`
  côté Server ; il reçoit `{ path, params, what }`. `app/not-found.tsx` sert aussi
  pour une URL qu'aucune page ne reconnaît.
- `[...name]` est un segment catch-all : il prend un ou plusieurs segments
  (`params.name` vaut `guide/install/linux`), doit être le dernier du chemin et ne
  porte pas de layout. À préfixe égal, `[param]` passe avant lui.

Le build génère `app/routeTree.gen.ts` (à versionner, ne pas éditer) : il déclare
le `Register` de TanStack, donc `to`, `params` et `useParams` sont typés d'après les
fichiers de l'application. Une route inconnue ou un paramètre manquant est une
erreur TypeScript. Navigation depuis un Client Component, sans `<Link>` DOM :

```tsx
"use client";
import { useNavigate } from "@luciole-sh/core/client";
const navigate = useNavigate();
void navigate({ to: "/notes/$id", params: { id: "1" } });
```

Comportement observable :

- La dernière navigation gagne. Une navigation qui en remplace une autre annule le
  signal de son loader ; une réponse tardive ne modifie jamais l'écran. Une fois
  le modèle racine reçu, le stream Flight n'est plus lié à ce signal : les
  sous-arbres `Suspense` d'un arbre mis en cache continuent d'arriver.
- Le loading s'affiche immédiatement (`pendingMs = 0`). Échap (`useApplication()
.cancel()`) revient localement à la dernière route résolue, sans la recharger.
- `refresh()` invalide la destination en cours ou la route montée ; l'application le
  lie à la touche de son choix (Ctrl+R dans les exemples). Pendant un refresh, l'arbre
  reste monté (`activity === "refresh"`) : champ, focus et saisie restent actifs. Un
  refresh échoué garde l'arbre monté et expose l'erreur dans `useConnection().error`,
  sauf un refresh refusé (`401`), qui le retire.
- Une navigation échouée affiche `error.tsx` à la place de la page, layouts montés.
- Un `401` redirige vers `unauthorizedPath` sans rendre de contenu protégé. Un
  `409` (build mismatch) est refusé avant décodage et purge le cache.
- Le cache est celui de TanStack (`staleTime` 0 : une page mise en cache s'affiche
  puis se revalide). Les annulations de navigation n'annulent jamais une mutation.
- Un état applicatif placé au-dessus du route tree (le store de Drafts de Notes, par
  exemple) survit aux démontages de pages. Les versions de Notes sont monotones.

Params optionnels (`[[...name]]`) et layouts Server persistants (modèle « un payload
Flight par segment ») restent hors contrat.

### Search params

Chaque page accepte des search params, des **chaînes** comme dans une URL (le
routeur n'applique pas la conversion JSON par défaut de TanStack : `"42"` reste
`"42"`). Le route tree généré déclare `validateSearch` (les valeurs non textuelles
sont ignorées) et `loaderDeps` : chaque search est une page distincte, rendue par le
Server et mise en cache à part ; retour et avance la restaurent.

```tsx
void navigate({ to: "/repos/$repo", params: { repo }, search: { state: "merged" } });
// Côté Server
export default function Page({
  params,
  searchParams,
}: {
  params: { repo: string };
  searchParams: Record<string, string>;
}) {}
```

Le Server revalide la search comme les params : au plus 32 clés `[\w.-]{1,64}`,
valeurs textuelles de 1 000 caractères au plus, sinon `400`. `useSearch()` la lit
côté Client. Un filtre qui doit répondre à chaque frappe reste un état local.

### Préchargement

`useRouter().preloadRoute({ to, params })` rend la page en arrière-plan ; la
navigation suivante l'affiche sans attendre le réseau et sans nouveau rendu tant que
l'arbre préchargé est frais (`preloadStaleTime` de TanStack, 30 s). Le préchargement
passe par le même loader : auth, `setToken()` et purge du cache s'appliquent.

### Streaming au-delà du modèle racine

Une page peut passer à un Client Component une `Promise` (lue avec `use()` sous
`Suspense`) ou un async iterable : Flight les livre au fil de l'eau dans la même
réponse, sans protocole supplémentaire. Le timeout du transport borne seulement
l'attente du modèle racine. Un async iterable ne se lit qu'une fois alors qu'un arbre
en cache peut être remonté, et le stream d'un arbre quitté continue pour le cache :
pour un flux lié à l'écran, préférer `useLive`.

### Géométrie du loading

Un écran d’attente et son contenu final doivent partager leurs règles de layout.
Notes utilise `components/NoteFrame.tsx`, un module de présentation sans accès
Server : même layout, titre sur une ligne, cadre de champ de cinq lignes,
emplacements fixes pour statut, messages et aide. Le texte long est tronqué dans
ces emplacements. Le chrome de Notes affiche les indications de navigation et de
refresh dans son en-tête de hauteur fixe. Aucun élément temporaire ne décale la page.

Le framework ne peut pas déduire les dimensions d’une page Server encore inconnue :
cette stabilité est un contrat de présentation de l’application, vérifié par les
tests de géométrie. Une animation de loading doit conserver ces dimensions et ne
modifier que les couleurs ou des glyphes de largeur constante. Notes fournit une
pulsation grise locale avec `useTimeline` d’OpenTUI : son cycle complet dure 1,7 seconde,
avec une opacité qui varie de 1 à 0,2 puis revient à 1. Le squelette part d’un gris clair pour
rester perceptible sur les terminaux sombres. Le nettoyage arrête la timeline au
démontage ; elle ne touche ni au transport ni à l’état Server.
