# Spec v3 — `examples/coder` : un client TUI multi-harness pour airtty

> Statut : **validée par l'utilisateur** (2026-09-26), décisions finales dans `docs/CODER-HANDOFF.md`
> (qui prime en cas d'écart). Rapports : `docs/coder/research/*.md`.

## 1. Vision

Un exemple airtty qui fait ce que font `claude`, `codex`, `pi` et `opencode` dans un terminal — **une
session, un dossier, un agent** — mais avec **n'importe lequel des quatre en dessous**,
choisi par `--harness claude|codex|pi|opencode`. L'app ne parle jamais à un LLM, ne lit aucun
jeton : elle pilote les binaires officiels déjà installés et connectés.

C'est aussi **la vitrine d'airtty** : chaque capacité du framework y a une raison d'être.

| Capacité airtty | Ce qu'elle apporte ici |
|---|---|
| Server / Client séparés | Le Server possède la session agent : le Client peut crasher, être rebuild, se déconnecter — l'agent continue, on se rattache |
| `ssh://` | **Agent sur une machine distante, UI en local** (le `claude`/`codex`/`pi` de la machine distante, connecté par son propriétaire) |
| `useLive` | Flux d'événements de l'agent vers le Client |
| Issues `not-sent / rejected / unknown` | Une approbation n'est **jamais rejouée** : une issue inconnue est consultée (réponse idempotente par id) |
| Drafts restaurés | Le prompt en cours survit à un crash/rebuild |
| `useBindings` + `<KeyHelp>` | Modes clavier (prompt / parcours / dialogue) et aide générée |
| `host.notify` | Notification OS quand une approbation attend |
| `renderer.suspend()` | Ctrl+G : éditer le prompt dans `$EDITOR` |
| `<Terminal>` | `!commande` ou tiroir shell dans le dossier de session |
| DevTools, `AIRTTY_LATENCY_MS` / `AIRTTY_FAULT` | Observer le flux, éprouver l'app à 500 ms de ping |
| Cible web | Démo du site avec un harness factice |

## 2. Conformité (garde-fous non négociables)

| Harness | Règle | Implémentation |
|---|---|---|
| Claude Code | Binaire officiel non modifié, login de l'utilisateur | Agent SDK `query()` + `pathToClaudeCodeExecutable` = `claude` de l'utilisateur ; jamais `--bare` ; `env: {...process.env}` ; aucun appel `oauth/*`, aucun user-agent usurpé (contrairement à `claudeResetCredits.ts` de T3) |
| Claude Code | Pas d'usurpation de marque | « powered by Claude Code » en texte seulement |
| Codex | Login géré par Codex | `account/read` ; si déconnecté → message « lancez `codex login` » ; `clientInfo.name = "airtty-harness"` |
| pi | **Pas d'OAuth Anthropic dans pi** | Détection (`auth check`, `auth.json` type, préfixe `sk-ant-oat`, env `ANTHROPIC_OAUTH_TOKEN`/`AUTH_TOKEN`) → modèles Anthropic retirés, variables retirées de l'env enfant, message « utilisez `--harness claude` » |
| opencode | **Pas d'OAuth Anthropic dans opencode** | `auth.json` `.anthropic.type == "oauth"` (lu via jq, type seul), `GET /provider/auth` avec méthode oauth anthropic, plugin `/anthropic|claude/i` dans `GET /config` → modèles Anthropic bloqués, message « utilisez `--harness claude` » ; partage (`/share`) désactivé |
| Tous | Zéro secret | Jamais de lecture de `.credentials.json`, `auth.json` (sauf *type* pi via clés, sans valeurs), Keychain |

Facturation : affichée, jamais interprétée. Aujourd'hui SDK / `claude -p` / apps tierces
puisent dans l'abonnement ; le crédit séparé du 15/06/2026 est **en pause**.
README : licence du SDK Anthropic (non OSI) mentionnée ; usage perso non commercial.

## 3. Lancement

```sh
coder --harness claude|codex|pi|opencode [--cwd DIR] [--model M] [--effort E]
      [--mode read|ask|edits|full] [--resume [ID]]
bun run coder -- --harness codex        # dev (airtty dev --app examples/coder -- …)
coder --help                            # généré depuis app/args.ts
```

- Arguments d'app = **changement framework** (voir handoff §4) : `app/args.ts` déclare un
  schéma Zod, le framework parse, génère `--help`, valide, transmet au Server.
- Sans `--harness` : premier harness **prêt** dans l'ordre claude → codex → opencode → pi,
  sinon erreur listant ce qui manque et comment l'installer/le connecter.
- **Plusieurs sessions en parallèle dans le même projet** : chaque lancement a son propre
  Server (`"server": "per-launch"` dans le manifeste), donc son propre process harness.
  Un Client qui crashe se rattache à sa session au relancement (claim d'orphelin) ;
  `--new` force une session neuve.

## 4. Architecture

```
Client (OpenTUI)                          Server (Bun, un process)
┌──────────────────────────┐   Flight    ┌───────────────────────────────────────┐
│ app/layout.tsx (client)  │◄──useLive───│ server/session.ts  Session (singleton)│
│  SessionScreen           │             │   état, blocs, requêtes en attente,   │
│   Transcript  Composer   │──actions───►│   journal seq → patchs                │
│   Dialogs     StatusLine │             │ server/adapters/                      │
└──────────────────────────┘             │   claude.ts  → claude-agent-sdk       │
                                         │   codex.ts   → codex app-server (RPC) │
                                         │   pi.ts      → pi --mode rpc + gate   │
                                         │   opencode.ts→ opencode serve HTTP/SSE│
                                         │ server/detect.ts  (sans requête LLM)  │
                                         │ server/jsonl.ts   (lecteur LF + RPC)  │
                                         └───────────────────────────────────────┘
```

- **Réutilisé de `examples/agent`** : lecteur JSON-lines (généralisé en client JSON-RPC
  pour codex), itérateur `subscribe()` fermable, `Frame`/`Line`/`Pulse`/`theme`, champ
  prompt nommé, modes clavier, parcours PTY sans process orphelin.
- **Nouveau** : interface `HarnessAdapter` + modèle d'événements neutre ; **snapshot puis
  patchs** (`{seq, ops}`) au lieu d'un snapshot complet toutes les 50 ms ; requêtes en
  attente (approbation / question / plan) comme entrées adressables par id.
- Actions courtes (< 10 s) : `send`, `steer`, `interrupt`, `respond(id, decision)`,
  `setModel`, `setEffort`, `setMode`, `compact`, `newSession`, `resume(id)`, `rewind(turn)`.
  Tout le reste passe par le flux.
- Rebuild / reconnexion : le Server garde la session vivante ; au redémarrage du Server,
  l'adaptateur reprend (`resume` Claude, `thread/resume` Codex, `--session-id` pi).

### 4.1 Adaptateur

```ts
interface HarnessAdapter {
  readonly id: "claude" | "codex" | "pi" | "opencode";
  detect(): Promise<HarnessStatus>;           // installé, version, auth, avertissements
  readonly capabilities: Capabilities;
  start(o: { cwd: string; resume?: string; model?: string; mode: Mode }): Promise<void>;
  send(input: UserInput[]): Promise<void>;
  steer(input: UserInput[]): Promise<void>;
  interrupt(): Promise<void>;
  respond(requestId: string, r: RequestResponse): Promise<void>;
  setModel(model: string, effort?: string): Promise<void>;
  setMode(mode: Mode): Promise<void>;
  compact(): Promise<void>;
  listSessions(cwd: string): Promise<SessionSummary[]>;
  commands(): Promise<Command[]>;             // commandes / skills natifs
  models(): Promise<Model[]>;
  events(): AsyncIterable<HarnessEvent>;
  close(): Promise<void>;
}
```

### 4.2 Modèle d'événements

```
turn.started / turn.completed{status, usage}
item.started / item.delta / item.completed — kind :
  message | reasoning | command{cmd, cwd, output, exit} | file_change{path, patch}
  | tool{name, input, result} | subagent | compaction | notice
plan.updated{steps[{text, status}]}
request.opened{id, kind: approval | question | plan_review, payload} / request.resolved{id}
usage.updated{context{used, window}, plan?{fiveHour, weekly, resetsAt}, costUsd?}
```

| Commun | Claude (SDK) | Codex (app-server) | pi (RPC) | opencode (HTTP/SSE) |
|---|---|---|---|---|
| message delta | `stream_event` | `item/agentMessage/delta` | `message_update` text_* | `message.part.delta` (field text) |
| reasoning | thinking (`display:'summarized'`) | `item/reasoning/*Delta` | thinking_* | part `reasoning` |
| command | tool `Bash` | `commandExecution` + `outputDelta` | `tool_execution_*` bash | part `tool` bash (state pending→running→completed) |
| file_change | tools `Edit`/`Write` | `fileChange` | `tool_execution_*` edit/write | part `tool` edit/write + `patch`, `session.diff` |
| approval | `canUseTool` | `item/*/requestApproval` | `extension_ui_request` (gate) | `permission.asked` → `POST /permission/{id}/reply` |
| question | `AskUserQuestion` | `item/tool/requestUserInput` | `extension_ui_request` select/input | `question.asked` → `/question/{id}/reply` |
| plan review | `ExitPlanMode` | `collaborationMode: plan` | extension plan-mode | agent `plan` ↔ `build` |
| usage | `rate_limit_event`, `getContextUsage` | `thread/tokenUsage`, `account/rateLimits` | `get_session_stats` | `step-finish` tokens/cost |
| fin de tour | `result` | `turn/completed` | `agent_settled` | `session.status` idle |

### 4.3 Détection (aucune requête modèle)

| | Claude | Codex | pi | opencode |
|---|---|---|---|---|
| Binaire / version | `claude --version` | `initialize` → userAgent | `pi --version` | `GET /global/health` → version |
| Auth | `claude auth status` (JSON) ; alerte si `ANTHROPIC_API_KEY` écrase l'abonnement | `account/read` | `pi auth check --provider X --json --no-refresh` | `opencode providers list` (types, pas de secrets), `GET /provider` `connected` |
| Catalogue | `supportedModels()`, `supportedCommands()` | `model/list`, `skills/list` | `get_available_models`, `get_commands` | `GET /provider`, `/agent`, `/command`, `/skill` |

### 4.4 Modes de permission

| Mode (`--mode`, `/mode`, Maj+Tab) | Claude | Codex | pi (gate) | opencode (règles de session) |
|---|---|---|---|---|
| `read` Lecture seule | `plan` | `read-only` + `on-request` | outils `read,grep,find,ls` | agent `plan` / edit,bash `deny` |
| `ask` Demander (défaut) | `default` | `workspace-write` + `on-request` | gate sur tout sauf lecture | edit,bash,webfetch `ask` |
| `edits` Éditions auto | `acceptEdits` | `workspace-write` + `on-request`, fichiers auto-acceptés | gate sur bash seulement | edit `allow`, bash `ask` |
| `full` Accès complet | `bypassPermissions` | `danger-full-access` + `never` | sans gate | tout `allow` |

Réponses : `y` une fois · `s` pour la session · `a` toujours (si supporté) · `n` refuser ·
`Échap` refuser et interrompre.

## 5. UI (OpenTUI 0.5.12, plein écran)

Plein écran avec `<scrollbox stickyScroll stickyStart="bottom">`, comme `examples/agent`.
Le mode `split-footer` d'OpenTUI (scrollback natif façon Claude Code) est tentant mais
(1) airtty ne l'expose pas, (2) un tour commité ne se replie plus, (3) incompatible avec la
cible web. → v2 éventuelle, derrière un flag.

```
┌ ◐ claude · ~/workdir/airtty · Fix live demo mismatch ─────────────── ssh:devbox ┐
│                                                                                  │
│ › corrige le mismatch des démos live                                             │
│                                                                                  │
│ ▸ Réflexion · 3 s                                                                │
│ Je regarde **frames.ts** — le mapping des captures est décalé d'un index.        │
│ ▾ $ bun test tests/live.test.tsx                               ✓ 42 passed 1.2 s │
│   │ 42 pass · 0 fail                                                             │
│ ▾ ✎ src/lib/frames.ts                                                  +6 −2     │
│   │ 12  - const frame = frames[i + 1]                                            │
│   │ 12  + const frame = frames[i]                                                │
│ ◇ Tâche « explore captures » · 4 outils · en cours                               │
│──────────────────────────────────────────────────────────────────────────────────│
│ ☐ Plan  ✓ lire frames.ts   ● corriger le mapping   ○ relancer les tests          │
│╭────────────────────────────────────────────────────────────────────────────────╮│
││ › Message…                                                                     ││
│╰────────────────────────────────────────────────────────────────────────────────╯│
│ opus 5.5 · high · ✋ ask │ ctx ▓▓▓▓░░ 61 % │ 5h 42 % · 7j 18 % │ ⏎ envoyer ^G éditeur│
└──────────────────────────────────────────────────────────────────────────────────┘
```

| Zone | Composants |
|---|---|
| Transcript | `<scrollbox>` ; blocs figés/memoïsés une fois terminés (perf #1339/#1493) |
| Message agent | `<markdown streaming conceal>` + grammaires tree-sitter ajoutées (py, go, rust, sh, json…) sinon blocs vides (#1494) |
| Réflexion | bloc replié par défaut, texte atténué |
| Commande | en-tête ▸/▾ (`onMouseDown`), sortie en direct (queue 12 lignes), `<code>` ; complète au dépliage |
| Édition fichier | `<diff>` unifié (split si ≥ 140 colonnes), un patch par fichier |
| Sous-agent / tâche | ligne repliable + compteur dans le statut |
| Plan | bandeau collant au-dessus du composer |
| Composer | `<Textarea name="prompt">` (restauré) ; ⏎ envoie, Maj+⏎ / Ctrl+J nouvelle ligne ; collage d'image (presse-papier) ; Ctrl+G `$EDITOR` |
| Complétion | popup maison (box absolue haute `zIndex` ancrée au curseur) pour `/` et `@fichier` |
| Dialogues | overlay à la `ContextMenu` (files) : approbation (commande en `<code>` ou `<diff>`), question (options), revue de plan (`<markdown>`) ; prend le clavier |
| Sélecteurs | `/model`, `/mode`, `/resume` : input + liste filtrée (patron `Library` de mdreader) |
| Statut | ligne flex : modèle · effort · mode · contexte · limites · tâches · `<KeyHelp inline>` |
| Copie | sélection → OSC 52 |

Contournement #1514 (le scroll collant arrache la lecture quand un bloc se replie) : on
désactive `stickyScroll` dès que l'utilisateur remonte, réactivé par `End` / `G`.

## 6. Clavier

| Mode | Touches |
|---|---|
| Prompt (défaut) | ⏎ envoyer (en cours de tour : injecter) · ⌥⏎ mettre en file · Échap interrompre · Échap Échap rewind · Maj+Tab mode suivant · Ctrl+G éditeur · Ctrl+O parcours · `/` commandes · `@` fichiers · `!` shell |
| Parcours | `j`/`k` bloc · ⏎/Espace plier · `a` tout plier · `y` copier le bloc · `g`/`Maj+g` haut/bas · `i` ou Échap retour prompt |
| Dialogue | `y` `s` `a` `n` · chiffres pour les options · Échap |
| Global | PgUp/PgDn · Ctrl+R rafraîchir le flux · Ctrl+C ×2 quitter (l'agent est arrêté proprement) |

## 7. Commandes `/`

- **De l'app** (les 3 harnesses) : `/new` `/resume` `/model` `/effort` `/mode` `/plan`
  `/compact` `/diff` (tiroir diff de session) `/rewind` `/fork` `/status` (compte, versions,
  source d'usage) `/help`.
- **Du harness**, telles qu'exposées : skills, prompts, commandes de plugins.
- Une commande que le harness ne sait pas faire **n'apparaît pas** (matrice de capacités).

## 8. Tests

- **Harness factice** (`server/adapters/fake.ts`, scénarios scriptés : stream, outil,
  approbation, question, plan, erreur) → sert les tests, la cible web et la démo du site.
- Intégration (`tests/harness.test.tsx`) : build + vrai Server + `testRender`, sur le
  factice. Cas clés : approbation avec réponse perdue (`AIRTTY_FAULT=drop`) → pas de
  double réponse ; reconnexion au milieu d'un tour ; prompt restauré après crash.
- Contrats par adaptateur : rejouer des fixtures JSONL enregistrées sur les vrais binaires
  (`claude` 2.1.283, `codex` 0.156.1, `pi` 0.87.1, `opencode` 1.18.31) → événements neutres attendus.
- PTY `scripts/pty/harness.ts` : parcours complet sur le factice ; parcours réels manuels.

## 9. Périmètre

**v1** : les 4 adaptateurs + factice, détection, sessions parallèles (per-launch), `--harness`, streaming
markdown, outils/diffs, approbations/questions/plan, modes, modèle/effort, `/resume` `/new`
`/compact`, commandes natives, statut, ssh distant, drafts, notifications.

**v2** : `/rewind` (checkpoints git), `/fork`, `!` et tiroir `<Terminal>`, tiroir diff de
session, images, split-footer, MCP (statut + `needs-auth`), review Codex.

**Hors périmètre** : multi-session, proxy LLM, comptes, lecture de jetons.

## 10. Risques

- Protocole Codex « experimental » → types générés (`codex app-server generate-ts`) à
  partir de 0.156.1, vérif de version au démarrage.
- Agent SDK dans le bundle Server : vérifier que `pathToClaudeCodeExecutable` évite toute
  résolution du `cli.js` embarqué via `import.meta.url` ; sinon laisser le SDK `external`.
- pi sans permissions natives → la gate est un point de sécurité à tester sérieusement.
- Perf OpenTUI sur longs transcripts (#1339, #1493) → blocs figés, plafond de blocs, spinner
  lent seulement en cours de tour.
- Schéma `ExitPlanMode` peu documenté → fixture réelle avant d'implémenter.

## 11. Décisions (ex-questions ouvertes)

1. Nouvel exemple **`examples/coder`** ; `examples/agent` n'est pas touché.
2. Arguments d'app : changement framework accepté (parseur maison piloté par Standard Schema).
3. **Pas d'instance unique** : plusieurs sessions par projet (Server per-launch).
4. Ordre : framework → factice + Claude → Codex → pi → opencode.
5. Nom : `coder`.
