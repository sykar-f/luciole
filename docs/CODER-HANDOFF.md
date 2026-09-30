# Handoff : `examples/coder`, un client TUI pour Claude Code, Codex, pi et opencode

Branche `feat/coder`, worktree herdr `~/.herdr/worktrees/luciole/feat-coder`, partie de
`main` à `01c8558`. Ce document **prime** sur `docs/coder/SPEC.md` en cas d'écart ; la spec
détaille l'UI, les tables de correspondance et la matrice de capacités ; les rapports de
`docs/coder/research/` sont la source de vérité protocolaire (lire celui du harness avant
d'écrire son adaptateur).

> Les rapports citent parfois `/private/tmp/claude-501/research/...` (clone T3 Code, schémas
> Codex générés, OpenAPI opencode) : ces fichiers peuvent avoir disparu. Tout se régénère :
> `git clone --depth 1 https://github.com/pingdotgg/t3code` (étudié à `95030dc`),
> `codex app-server generate-ts --out DIR [--experimental]`,
> `opencode serve --port 0` puis `GET /doc`.

## 1. Mission

Construire **un nouvel exemple luciole, `examples/coder`** : l'équivalent de `claude`,
`codex`, `pi` ou `opencode` lancés dans un terminal — **une session, un dossier, un agent** —
mais avec le harness choisi au lancement :

```sh
coder --harness claude|codex|pi|opencode [--cwd DIR] [--model M] [--effort E] \
      [--mode read|ask|edits|full] [--resume [ID]] [--new]
```

C'est aussi **la vitrine de luciole** : exploiter au maximum le framework (Server qui possède
la session, `useLive`, issues de requête, drafts, `useBindings`/`KeyHelp`, `host.notify`,
`renderer.suspend()` pour `$EDITOR`, `ssh://`, DevTools, simulation de latence/fautes,
cible web avec harness factice) et OpenTUI 0.5.12 (markdown streaming, `<diff>`, `<code>`,
textarea, overlays, sélection + OSC 52).

Pour y arriver, **deux changements du framework** sont nécessaires et font partie de la
mission (phases 1 et 2) : arguments d'application de première classe, et Server par
lancement pour permettre plusieurs sessions dans un même projet.

## 2. Décisions de l'utilisateur (ne pas rediscuter)

| Sujet            | Décision                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| UX               | **Mono-session** comme les CLI claude/codex/pi, pas un multi-threads à la T3 Code                          |
| Choix du harness | Flag **`--harness claude\|codex\|pi\|opencode`**                                                           |
| Instances        | **Plusieurs sessions en parallèle dans le même projet** doivent être possibles (pas d'instance unique)     |
| Forme            | **Exemple luciole** (TUI OpenTUI), pas d'app web/Tauri                                                     |
| Arguments        | **Changement architectural du framework** accepté : l'app déclare de vrais arguments CLI avec une bonne DX |
| Exemple          | **Nouvel exemple `examples/coder`** ; **ne pas toucher `examples/agent`**                                  |
| Nom              | `coder`                                                                                                    |
| Ordre            | framework → harness factice + Claude → Codex → pi → opencode                                               |
| Cible            | Perso + open source public, **non commercial**                                                             |

Décisions prises par le coordinateur (modifiables si tu as une raison forte, à justifier) :

- **Parseur d'arguments maison, sans nouvelle dépendance**, piloté par Standard Schema +
  Standard JSON Schema (zod 4.6.5 déjà dans le repo). Comparatif complet dans
  `research/cli-args-report.md` : commander/citty/cac n'ont pas de schéma, `util.parseArgs`
  ne sait pas exprimer `--resume [ID]` (sonde faite), clipanion est à l'abandon. Plan B
  « acheter » : **cleye 2.7.0** (Standard Schema natif) ; évolution : **@optique/core**
  si complétions shell. Si le parseur maison dépasse ~300 lignes ou tourne mal, bascule sur
  cleye et documente pourquoi.
- **`"server": "per-launch"`** (option de manifeste) plutôt qu'un Server multi-tenant.
- **Plein écran** avec `<scrollbox>` (pas le mode `split-footer` d'OpenTUI : non exposé par
  luciole, tours commités non repliables, incompatible web).
- Défaut de permission : **`ask`** (T3 met « full access » par défaut, on ne le fait pas).

## 3. Conformité — garde-fous non négociables

Contexte (vérifié en ligne le 2026-09-26) : Anthropic interdit d'utiliser le jeton OAuth
d'un abonnement Claude hors de ses applications (Consumer Terms + page Legal and compliance
de Claude Code ; bloqué côté serveur depuis le 2026-04-04 ; des comptes ont été bannis en
janvier 2026, surtout OpenCode). En revanche, **piloter le binaire officiel `claude` non
modifié, connecté par l'utilisateur, via l'Agent SDK** est le schéma accepté (confirmation
rapportée par T3 Code ; la page Legal l'autorise explicitement ; le Help Center 15036540
dit que SDK / `claude -p` / apps tierces puisent aujourd'hui dans les limites de
l'abonnement — le crédit séparé annoncé pour le 2026-06-15 est **en pause**).

Règles :

1. **Claude** : `@anthropic-ai/claude-agent-sdk` `query()` avec
   `pathToClaudeCodeExecutable` = le `claude` de l'utilisateur (résolu dans le `PATH`).
   Ne jamais installer/utiliser le binaire embarqué du SDK (T3 l'exclut via
   `pnpm-workspace.yaml` ; faire l'équivalent ou s'assurer qu'il n'est jamais résolu).
   Jamais `--bare` (ne lit pas l'OAuth). `env: {...process.env, …}` (l'option `env`
   **remplace** tout l'environnement). Ne jamais changer `HOME` (casse le Keychain macOS).
2. **Zéro secret** : ne jamais lire `~/.claude/.credentials.json`, le Keychain,
   `~/.codex/auth.json`, les valeurs de `~/.pi/agent/auth.json` ou
   `~/.local/share/opencode/auth.json`. Seules exceptions : le **champ type** d'une entrée
   (`jq -r '.anthropic.type // empty'`) et un **test de préfixe** `sk-ant-oat` sans
   afficher la valeur. Jamais `pi auth check --credentials`.
3. **Aucun appel** aux endpoints `api.anthropic.com/api/oauth/*`, aucun user-agent usurpé.
   (T3 le fait dans `claudeResetCredits.ts` : **ne pas copier**. Ne pas copier non plus son
   intégration CLIProxyAPI de mutualisation de comptes.)
4. **Login toujours délégué au harness** : si déconnecté, afficher la commande à lancer
   (`claude auth login`, `codex login`, `/login` dans pi, `opencode auth login`). Codex
   expose aussi `account/login/start` (le binaire héberge le callback) : acceptable.
5. **Pas d'OAuth Anthropic dans pi ni dans opencode** :
   - pi : bloquer les modèles Anthropic si `pi auth check --provider anthropic --json
--no-refresh` → `authType:"oauth"`, ou `auth.json` `.anthropic.type == "oauth"`, ou
     clé commençant par `sk-ant-oat` (auth.json, `models.json`, env `ANTHROPIC_API_KEY`),
     ou env `ANTHROPIC_OAUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN` présent. **Piège vérifié** :
     `auth check` répond `api_key` pour un jeton OAuth passé par env → tester aussi l'env.
     Retirer ces variables de l'env enfant, bloquer dans le sélecteur, `set_model` et
     `cycle_model`, message « utilisez `--harness claude` ».
   - opencode : bloquer si `auth.json` `.anthropic.type == "oauth"`, ou `GET /provider/auth`
     propose une méthode oauth pour `anthropic`, ou un `plugin[]` de `GET /config`
     correspond à `/anthropic|claude/i`. Vérifier au choix du modèle **et** avant chaque
     prompt. Claude via Copilot/Zen/Bedrock/Vertex/OpenRouter/clé API = OK.
6. Pas d'usurpation de marque : nom propre `coder`, mention texte « powered by … ».
   Codex : `clientInfo.name = "luciole-coder"`. opencode : partage public (`/share`) désactivé.
7. README : mentionner que la licence de l'Agent SDK Anthropic n'est pas OSI (usage perso
   non commercial) et que chaque harness consomme le quota de l'utilisateur.

## 4. Phase 1 — Arguments d'application (framework)

Design complet : `research/cli-args-report.md`. Résumé à implémenter :

**État actuel** (4 parseurs faits main, aucune lib) : `cli.ts` (indexOf), `commands/dev.ts`
ignore les arguments en trop et spawn le Server avec `{...process.env, PORT}`,
`launcher/index.ts` `builtArgs()` n'accepte que `--url`/`--grace`, `launcher/binary.ts`
`flags()` lève `Unknown argument`.

**API proposée** :

```ts
// examples/coder/app/args.ts
import { defineArgs } from "luciole/args";
import { z } from "zod";

export default defineArgs({
  summary: "Coding agent client for Claude Code, Codex, pi and opencode",
  options: z
    .object({
      harness: z
        .enum(["claude", "codex", "pi", "opencode"])
        .optional()
        .meta({ short: "H", description: "Underlying agent harness" }),
      cwd: z.string().optional().meta({ kind: "path", placeholder: "DIR" }),
      model: z.string().optional(),
      effort: z.string().optional(),
      mode: z.enum(["read", "ask", "edits", "full"]).default("ask"),
      resume: z
        .union([z.literal(true), z.string()])
        .optional()
        .meta({ placeholder: "ID", description: "Resume the latest or a given session" }),
    })
    .strict(),
  examples: ["coder --harness codex", "coder -H claude --resume"],
});
```

- `.meta()` : `short`, `placeholder`, `description`, `kind: "path"` (résolu contre le cwd
  d'invocation), `env` (repli sur une variable). `true | string` = flag à valeur
  optionnelle ; tableaux = répétable ; booléens acceptent `--no-x`.
- Nouveau point d'entrée `luciole/args` (`src/args.ts`) : `defineArgs`, parseur (grammaire +
  aide générées depuis le JSON Schema, validation via `~standard.validate`, « did you
  mean », code de sortie 2 sur erreur).
- Build : découvrir `app/args.ts`, le bundler en `.luciole/args`, y interdire les imports
  `server-only`, écrire son JSON Schema dans `metadata.json`, **échouer si l'app déclare
  un flag réservé** : `--url --on --target --grace --yes --help -h --version --new`, `serve`.
- `--help` généré : options de l'app d'abord, puis options runtime luciole.
- Entrées : `luciole dev --app d -- <args>` (le script racine finit par `--`, donc
  `bun run coder -H codex` marche) ; `luciole ./app <args>` ; binaire `coder <args>` et
  `coder serve … -- <args>` ; `--on host` : arguments transmis par **stdin ssh** ;
  `--url`, Client générique et `--web-local` **refusent** les arguments d'app.
- Transport vers le Server : env `LUCIOLE_ARGS={v, argv, cwd}` (jamais la ligne de commande,
  visible dans `ps`) ; le Server **re-parse** avec le même code (il fait autorité).
- Lecture côté Server : `import cli from "../app/args"; cli.get()` typé ; `luciole/server`
  gagne `getArgs()` et `getLaunch()`. **Pas d'API Client** : la page passe en props ce
  dont l'UI a besoin.
- Tests : `args`, `args-types` (inférence), `args-build` (flags réservés, JSON Schema),
  `server-args` ; étendre `binary`, `launch`, le stand-in ssh ; parcours PTY `dev`.
- Docs (en français) : API, DISTRIBUTION, ARCHITECTURE, BOUNDARIES, DESKTOP, WEB, README.

## 5. Phase 0 + 2 — Sessions parallèles (framework)

**Phase 0, prérequis à faire en premier** : deux lancements / `luciole dev` concurrents de la
même app **se marchent dessus dans `.luciole/`** (le build échange des dossiers par rename
sans verrou). Ajouter un **verrou de build** et **sauter le build si le buildId est
inchangé** (il est calculé avant le bundling). Utile même sans coder.

**Phase 2** — état actuel : clé de session `local:<dir>` / `git:<repo>` / `local:<name>`
(binaire) / `ssh:<dest>/<name>`, socket
`<$XDG_RUNTIME_DIR/luciole | /tmp/luciole-uid>/<sha256(key)[:16]>.sock`, `ensureServer`
réutilise si même buildId ; **l'env du premier lancement gagne**, la clé n'inclut ni cwd,
ni env, ni args (un binaire lancé dans le projet A puis B partage un Server qui tourne
dans A — bug latent). Durée de vie : ping client 10 s, watchdog 30 s, grâce 15 min après
crash, arrêt immédiat quand le dernier Client quitte volontairement ; `session.ts` sait
déjà faire reprendre la session la plus récente d'un Client mort (rename atomique).

À faire :

- Manifeste `package.json` : `"luciole": { "server": "shared" | "per-directory" |
"per-launch", "grace": "10m" }`. L'**empreinte des arguments entre toujours dans la
  clé** (un Server = un jeu d'arguments = constante de process).
- `per-launch` (coder) : clé `<target>@<cwd>#<fp>!<launchId>` → un Server par lancement.
- **Rattachement après crash** : le launcher cherche un fichier de session d'un Client mort
  dont la clé commence par `base!` et dont le Server est encore en grâce, le réclame
  (`claimOrphan`, rename atomique de `session.ts`), récupère le launchId et
  `LUCIOLE_SESSION` → le Client relancé retrouve son agent vivant, sa route et son draft.
  Flag réservé **`--new`** pour sauter le rattachement.
- Impact : `useLive` inchangé (le flux se rouvre, 1er élément = snapshot) ; reconnexion et
  durée de vie inchangées ; ssh : clé + args par stdin ; binaires : scope depuis les
  métadonnées embarquées (corrige `local:<name>`) ; `sqliteCache` partagé : ajouter
  l'empreinte aux clés.
- Fichiers : `build.ts`, `app-metadata.ts`, `server.ts`/`serve.ts`, `lifetime.ts`,
  `managed.ts`, nouveau `launcher/launch-key.ts`, `session.ts`, `launcher/index.ts`,
  `local.ts`, `binary.ts`, `remote.ts`, `compile.ts`, `commands/dev.ts`, `start.ts`,
  `generic`/`connect.ts`. Tests : `server-scope`, parcours PTY `lifetime`.
- Rejeté pour v1 : Server multi-tenant (état global, cwd, env qui fuient entre sessions ;
  un crash tue tout). `getLaunch()` laisse la porte ouverte.

## 6. Phase 3 — Squelette `examples/coder` + harness factice

Structure (conventions du repo, cf. `research/luciole-report.md` §3) :

```
examples/coder/
  package.json            luciole: workspace:*, deps en catalog:, "luciole": {"server":"per-launch"}
  tsconfig.json           extends luciole/tsconfig
  README.md               en français
  app/args.ts             §4
  app/layout.tsx          "use client" — écran de session
  app/page.tsx            Server — snapshot initial
  app/loading.tsx         même géométrie que la page (Frame partagé)
  app/routeTree.gen.ts    généré, commité
  actions/session.ts      "use server" : send, steer, interrupt, respond, setModel,
                          setEffort, setMode, compact, newSession, resume, feed
  server/session.ts       Session singleton : état, blocs, requêtes en attente, journal seq
  server/detect.ts        détection des 4 harnesses, sans requête modèle
  server/jsonl.ts         lecteur JSON-lines (LF uniquement) + client JSON-RPC générique
  server/adapters/{types,fake,claude,codex,pi,opencode}.ts
  server/pi-gate.ts       extension pi d'approbation (phase 6)
  components/…            SessionScreen, Transcript, blocks/*, Composer, Completion,
                          Dialogs, Pickers, StatusLine, PlanBar, theme, syntax
```

Racine : script `"coder": "bun packages/luciole/src/cli.ts dev --app examples/coder --"`,
`"test:pty:coder"`, ajouter `tsc --noEmit -p examples/coder` à `check`.

**Réutiliser d'`examples/agent`** (sans le modifier — copier/adapter) : lecture JSON-lines
sur LF seulement (readline casse sur U+2028), corrélation par `id`, stderr gardé (2 Ko),
**itérateur `subscribe()` écrit à la main** dont `return()/throw()` libèrent l'attente
(un `async function*` qui attend indéfiniment ne se ferme pas quand le Client part — piège
documenté), `Frame`/`Line`/`Pulse`/`theme`, champ prompt nommé restauré, modes clavier,
parcours PTY qui vérifie l'absence de process orphelin.

**Changer** : snapshot complet toutes les 50 ms → **snapshot initial puis patchs `{seq,
ops}`** ; blocs spécifiques pi → **modèle d'événements neutre** (spec §4.2) ; requêtes en
attente (approbation / question / revue de plan) **adressables par id**, et
`respond(id, decision)` **idempotent** : une réponse dont l'issue est `unknown` n'est
**jamais rejouée**, on consulte l'état (patron `examples/forge/components/operations.ts`).

Contraintes luciole à respecter : les actions ont un **timeout de 10 s** → elles rendent la
main vite, la progression passe par `useLive` ; `useLive` ne se reconnecte pas seul (Ctrl+R
/ changement d'args) ; `"use server"` n'exporte que des fonctions async nommées, arguments
**validés par Zod** ; lettres seules liées seulement quand aucun champ texte n'a le focus ;
`G` s'écrit `shift+g` ; `loading.tsx` partage la géométrie de la page.

**Harness factice** (`adapters/fake.ts`) avec scénarios scriptés (stream markdown, commande
avec sortie, édition avec diff, approbation, question, revue de plan, sous-agent, erreur,
compaction). Il sert : tests, cible web (pas de `child_process` dans le build tout-navigateur,
comme `CHAT_DEMO=1` de chat), démo éventuelle du site.

**UI** : voir spec §5–§7 (maquette, composants, clavier, commandes `/`). Points OpenTUI
(`research/opentui-report.md`) :

- `<markdown streaming conceal>` : n'embarque que les grammaires js/ts/markdown/zig —
  **ajouter** py, go, rust, bash, json, yaml, toml, diff… (`addDefaultParsers`) sinon les
  blocs de code sont **vides** (#1494). Voir `examples/chat` (`components/syntax.ts`).
- `<diff>` n'affiche que **le premier patch** → découper par fichier ; unifié, split si
  ≥ 140 colonnes ; pas de diff par mot. Patron : `examples/forge` `FilesReview.tsx` +
  `server/diff.ts`.
- Pas d'événement click : `onMouseDown`. Pas de popup de complétion, pas de liste
  filtrable, pas de thèmes : à construire (complétion = box absolue haut `zIndex` sous la
  racine — les positions absolues sont relatives au parent, #1512). Overlays : patron
  `examples/files/components/ContextMenu.tsx`. Listes filtrées : `examples/mdreader`
  `Library.tsx`.
- **#1514** : `stickyScroll` ramène en bas quand un bloc se replie → désactiver dès que
  l'utilisateur remonte, réactiver sur `End`/`shift+g`.
- **Perf** (#1339 : chaque rendu parcourt tout l'arbre ; #1493 : mémoire native) : figer et
  mémoïser les blocs terminés, un `<markdown>` par message, plafond de blocs, spinner lent
  et seulement pendant un tour.
- Textarea : lire `plainText` au submit (le changement arrive après `onSubmit`) ; ⏎
  envoie, Maj+⏎ / Ctrl+J nouvelle ligne ; `usePaste` pour gros collages et images.
- Copie : sélection → `copyToClipboardOSC52`. Notification : `host.notify` quand une
  requête attend et que le terminal n'a pas le focus (`useFocus`).

## 7. Phases 4–7 — Adaptateurs

Interface (spec §4.1) : `detect`, `capabilities`, `start({cwd, resume, model, mode})`,
`send`, `steer`, `interrupt`, `respond`, `setModel`, `setMode`, `compact`,
`listSessions`, `commands`, `models`, `events`, `close`. Les boutons/commandes sans
capacité **n'apparaissent pas**. Chaque adaptateur : fixtures JSONL enregistrées sur le
vrai binaire (petits prompts, `say ok`) rejouées en test de contrat → événements neutres.

### Phase 4 — Claude (`research/claude-code-report.md`, `research/t3code-report.md` §2)

- `query()` en **streaming input** (`AsyncIterable<SDKUserMessage>`), une `query` longue
  par session ; message pendant un tour = injecté (steer).
- Options : `cwd`, `model`, `effort`, `systemPrompt: {type:"preset", preset:"claude_code"}`
  (sinon prompt minimal !), `settingSources: ["user","project","local"]`,
  `permissionMode`, `allowDangerouslySkipPermissions` seulement en `full`, `resume` /
  `sessionId`, `includePartialMessages: true`, `canUseTool`, `thinking: {display:
"summarized"}` (sinon réflexion omise sur Opus ≥ 4.7), `env: {...process.env}`,
  `pathToClaudeCodeExecutable`.
- **Piège** : `ANTHROPIC_API_KEY` dans l'env **passe avant** l'abonnement en mode SDK →
  afficher un avertissement si `system/init.apiKeySource !== "none"` alors que
  `claude auth status` dit `claude.ai`.
- Détection : `claude --version`, `claude auth status` (JSON par défaut, exit 0/1 ;
  `loggedIn, authMethod, email, subscriptionType`), puis comme T3 un `query()` **sans
  prompt** pour lire `initializationResult()` (commandes, modèles, compte) sans appel API,
  hooks/MCP désactivés pour la sonde.
- `canUseTool(tool, input, {suggestions, signal, toolUseID, …})` → `{behavior:"allow",
updatedInput, updatedPermissions?}` (« toujours » = renvoyer une `suggestion`) ou
  `{behavior:"deny", message, interrupt?}`. Pas de timeout.
  **AskUserQuestion** et **ExitPlanMode** arrivent par `canUseTool` (réponse question :
  `updatedInput: {questions, answers: {[question]: label}}` ; plan : capturer le markdown,
  approuver + `setPermissionMode`, ou refuser avec feedback). Schéma ExitPlanMode peu
  documenté → **enregistrer une fixture réelle avant d'implémenter**.
- Runtime : `interrupt()`, `setPermissionMode`, `setModel`, `applyFlagSettings` (effort),
  `supportedCommands/Models`, `getContextUsage`, `accountInfo`, `rewindFiles`,
  `mcpServerStatus`. Limites du plan : `rate_limit_event` (`unifiedWindows` 5 h / 7 j) —
  **ne pas** utiliser l'appel d'usage expérimental.
- Sessions : helpers SDK `listSessions`, `getSessionMessages`, `forkSession`,
  `renameSession` (ne pas parser `~/.claude/projects`). Les sessions SDK ne sont pas dans
  le picker `claude --resume` mais se reprennent par id.
- Bundling : l'Agent SDK n'est importé que depuis `server/` ; le Server est bundlé par
  `Bun.build` → vérifier qu'aucun `cli.js` n'est résolu via `import.meta.url` ; sinon
  marquer le SDK `external`. Ajouter la dépendance au catalogue racine (pin exact) +
  `docs/DEPENDENCIES.md` + `bun audit` propre. SDK 0.3.N ↔ CLI 2.1.N (0.3.283 étudié).
- Todos : outils Todo/Task seulement par défaut sur anciens modèles —
  `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` pour les activer.

### Phase 5 — Codex (`research/codex-report.md`, `research/t3code-report.md` §3)

- `codex app-server` (stdio, JSON-RPC 2.0 en NDJSON **sans** champ `"jsonrpc"`). Protocole
  « experimental » et variable par version → **générer les types** depuis le binaire
  installé (`codex app-server generate-ts --out … --experimental`), commiter ceux de
  0.156.1, vérifier la version au démarrage.
- `initialize {clientInfo:{name:"luciole-coder",title,version}, capabilities:
{experimentalApi:true}}` puis notification `initialized`.
- `thread/start {model, cwd, approvalPolicy, sandbox, …}` / `thread/resume` /
  `thread/list {cwd}` ; `turn/start {threadId, input, model, effort, sandboxPolicy,
approvalPolicy, collaborationMode}` ; `turn/steer {expectedTurnId}` ; `turn/interrupt` ;
  `thread/compact/start` ; `thread/fork` ; `review/start` (v2).
- Notifications : `item/started|completed` (completed fait foi), `item/agentMessage/delta`,
  `item/reasoning/*`, `item/commandExecution/outputDelta`, `turn/diff/updated`,
  `turn/plan/updated`, `thread/tokenUsage/updated`, `account/rateLimits/updated`,
  `error {willRetry}`, `turn/completed`.
- Approbations = **requêtes serveur→client** : `item/commandExecution/requestApproval`
  → `{decision: accept|acceptForSession|{acceptWithExecpolicyAmendment}|decline|cancel}` ;
  `item/fileChange/requestApproval` ; `item/tool/requestUserInput` ;
  `mcpServer/elicitation/request`. Ordre : item/started → requête → réponse →
  `serverRequest/resolved` → item/completed.
- Sandbox/approbation : **faire confiance au schéma**, pas aux exemples des docs
  (`workspace-write`, pas `workspaceWrite`) ; `untrusted` retiré (peut empêcher le
  démarrage) ; `configRequirements/read` pour griser ce que l'admin interdit.
- Auth : `account/read` → `null | {type:"apiKey"} | {type:"chatgpt", email, planType}`.
  Ne jamais lire `~/.codex/auth.json`. Historique partagé avec CLI/VS Code (voulu).
- Modèles : `model/list` (efforts supportés par modèle, chaîne libre → picker construit
  depuis la liste). Skills : `skills/list`, invoqués `$name` + input `{type:"skill"}`.
  Mode plan : `collaborationMode {mode:"plan"}` (expérimental).

### Phase 6 — pi (`research/pi-report.md`)

- `pi --mode rpc --session-id <id> --approve|--no-approve -e <pi-gate.ts>` avec env
  nettoyé (§3.5). JSONL, découper sur LF uniquement.
- pi **n'a pas d'approbations** : écrire `server/pi-gate.ts`, extension qui intercepte
  `tool_call` et demande via `ctx.ui.select/confirm` → arrive en `extension_ui_request`
  → répondre `extension_ui_response {id, value|confirmed|cancelled}`. Plusieurs dialogues
  peuvent être en attente (outils parallèles). Modèles : `examples/extensions/
permission-gate.ts`, `plan-mode`, `protected-paths` dans le paquet pi installé.
  **Point de sécurité : à tester sérieusement.** Mode `read` = `--tools read,grep,find,ls`.
- Commandes : `prompt {message, images?, streamingBehavior}` (steer/followUp **obligatoire**
  pendant un stream), `steer`, `follow_up`, `abort`, `get_state`, `set_model`,
  `get_available_models`, `set_thinking_level`, `compact`, `new_session`,
  `switch_session`, `fork`, `get_session_stats`, `get_commands`, `get_entries`.
  Fin de tour : **`agent_settled`**. `message_end` fait foi sur les deltas.
- Pas de login ni de liste de sessions en RPC : lister en scannant
  `~/.pi/agent/sessions/--<cwd>--/*.jsonl` (en-tête `{type:"session", id, cwd}`).
- Détection : `pi --version`, `pi auth check --provider X --json --no-refresh` par
  provider, `get_available_models`.

### Phase 7 — opencode (`research/opencode-report.md`)

- Spawn `opencode serve --hostname=127.0.0.1 --port=0` avec
  `OPENCODE_SERVER_PASSWORD` **aléatoire par lancement** (Basic auth, user `opencode`),
  lire la ligne `opencode server listening on http://…`, puis `GET /global/health`.
  N'injecter `OPENCODE_CONFIG_CONTENT` que s'il n'est pas déjà défini. Un serveur par
  session coder (cohérent avec per-launch). Tuer le process à la fermeture.
- Client : `@opencode-ai/sdk/v2` (dépendance à ajouter au catalogue) ou fetch + SSE à la
  main si le SDK pèse trop — justifier. Répertoire via `x-opencode-directory`.
- Tour : `POST /session/{id}/prompt_async {model:{providerID,modelID}, agent, variant,
parts}` (204), suivi sur `GET /event` ; fin = `session.status` idle. Deltas :
  `message.part.delta` ; snapshots : `message.part.updated` (parts `text`, `reasoning`,
  `tool` avec états, `step-finish` tokens/coût, `patch`, `file`, `subtask`, `compaction`).
- Permissions : `permission.asked` → `POST /permission/{id}/reply {reply:
once|always|reject, message?}` ; questions : `question.asked` →
  `/question/{id}/reply {answers}` ; modes = règles de session `[{permission, pattern,
action}]` posées à la création / `PATCH` (à ré-appliquer à la reprise, comme T3).
- Après reconnexion SSE : re-lire `/session/status`, `/permission`, `/question`.
- Divers : `/abort`, `/fork`, `/revert`, `/summarize` (compaction), `/todo`, `/diff`,
  `GET /provider` (`connected`, variantes = effort), `/agent` (`build`/`plan`),
  `/command`, `/skill`. Sessions : `GET /session?directory=`.

## 8. Conventions du repo

- **Bun 1.4.2**, TS 7.0.2, zod 4.6.5, OpenTUI 0.5.12, React 19.3.0, `react-reconciler`
  0.33.0 (0.34 casse les transitions TanStack — ne pas monter).
- **Docs et README en français** ; code, commentaires, textes d'UI et messages de commit
  **en anglais**.
- Lint strict : pas de `any`, pas de `as` (sauf `as const`), pas de `!`, constantes nommées
  au lieu de nombres magiques, pas de promesses flottantes, **Zod à chaque frontière
  externe** (chaque ligne JSON d'un harness, chaque réponse HTTP).
- Dépendances : pin exact dans le catalogue racine, ligne dans `docs/DEPENDENCIES.md`,
  `bun audit` doit rendre `{}`.
- Tests : `bun test` ne lance que `tests/`. Intégration = build + vrai Server
  (`tests/helpers.ts` `launch`) + Client généré rendu avec `testRender` (voir
  `tests/live.test.tsx`, `tests/forge-helpers.tsx`). PTY : `scripts/pty/<app>.ts`
  (`driver.ts`, `harness.ts`), en TypeScript/Bun (plus de Python).
- **`bun run verify`** doit passer avant chaque commit significatif ; ne jamais se fier
  seulement au résultat d'une autre session.
- Commits : `type(scope): subject` (≤ 72 car.), corps qui explique **pourquoi** (fix :
  symptôme, cause, solution ; feat : besoin, approche), commits atomiques par
  fonctionnalité, trailer `Co-Authored-By` fourni par ton environnement.

## 9. Mode de travail

- Travaille **en autonomie** sur `feat/coder`, phase par phase, en committant au fil de
  l'eau. **Ne merge pas dans `main` et ne pousse pas** : le coordinateur (la session qui a
  écrit ce handoff) intègre.
- Arrête-toi seulement pour une décision qui appartient à l'utilisateur (direction produit,
  API publique non tranchée ci-dessus). Sinon décide, justifie dans le commit, avance.
- **Quota** : chaque prompt réel consomme l'abonnement de l'utilisateur. Tous les tests
  automatiques tournent sur le **harness factice** ; les enregistrements de fixtures réelles
  utilisent des prompts minuscules, une fois par harness et par scénario.
- Les quatre binaires sont installés : `claude` 2.1.283, `codex` 0.156.1 (connecté
  ChatGPT), `pi` 0.87.1 (openai-codex, openai et google prêts ; anthropic non configuré),
  `opencode` 1.18.31.
- Tiens `docs/coder/STATUS.md` à jour (phase en cours, fait, reste, décisions prises,
  écarts avec ce handoff). À la fin : résumé final dans ce fichier + message de fin de
  session.

## 10. Critères de fin

1. `bun run coder -- --harness <h>` fonctionne pour les 4 harnesses : streaming,
   outils/diffs, approbations/questions, plan, modes, modèle/effort, `/resume`, `/new`,
   `/compact`, commandes natives, ligne de statut.
2. Deux `coder` lancés dans le même dossier ont deux sessions indépendantes ; un Client tué
   se rattache à sa session au relancement ; `--new` force une session neuve.
3. `coder --help` généré ; argument invalide → message clair, code 2.
4. Garde-fous §3 couverts par des tests (OAuth Anthropic dans pi / opencode, env nettoyé,
   aucun accès aux fichiers d'identifiants).
5. `bun run verify` vert, parcours PTY `test:pty:coder` sur le factice, README français.
