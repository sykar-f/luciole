# État d'avancement — `examples/coder`

Branche `feat/coder`. Référence : [CODER-HANDOFF.md](../CODER-HANDOFF.md) (prime),
[SPEC.md](SPEC.md).

## Phase en cours

Toutes les phases du handoff (0 à 7) sont faites. Voir « Bilan » en fin de document.

## Fait

- **Préalable** — `docs(coder): format the handoff…` : les notes du handoff n'étaient pas
  passées par oxfmt, `verify` échouait.
- **Phase 0** — `fix(build): lock concurrent builds…` : verrou `mkdir` `.airtty-lock` ;
  build sauté si buildId et options identiques ; `package.json`, `airtty.json` et l'icône
  entrent dans le buildId.
- **Phase 1** — `feat(args): let applications declare…` : `airtty/args` (`defineArgs`,
  parseur maison sur Standard (JSON) Schema), `app/args.ts` bundlé dans `.airtty/args`,
  JSON Schema dans `metadata.json`, `AIRTTY_ARGS`, entrées dev / lanceur / binaire /
  `serve --` / `start --` / `--on` (stdin), code de sortie 2, docs FR. Correctifs
  ensuite : `fix(args): let Server modules read arguments at module level`,
  `fix(args): import the arguments module by absolute path`.
- **Phase 2** — `feat(launcher): give each launch its own Server…` : manifeste
  `airtty.server` (`shared` / `per-directory` / `per-launch`) et `airtty.grace`, clé
  `<cible>@<cwd>#<empreinte>!<id>`, réclamation d'orphelin (`claimOrphan`), `--new`,
  `getLaunch()`, empreinte dans le cache et dans `/lifetime/status`, `--on` par stdin,
  parcours PTY `test:pty:launches`.
- **Phase 3** — `feat(coder): add the coder example on a scripted harness` : modèle
  neutre, session (snapshot puis patchs, requêtes idempotentes, file d'attente),
  harness factice scripté, UI complète (transcript markdown / diff / commandes,
  dialogues, sélecteurs, complétion `/` et `@`, statut, plan, `$EDITOR`, OSC 52,
  notifications), 9 tests d'intégration (`tests/coder*.test.ts*`), parcours PTY
  `test:pty:coder`.

- **Phase 4** — `feat(coder): drive Claude Code through the Agent SDK` : adaptateur
  `server/adapters/claude.ts` (une `query()` longue en streaming input, `canUseTool` →
  approbations, AskUserQuestion → question, ExitPlanMode → revue de plan, TodoWrite →
  plan, sous-agents, limites 5 h / 7 j par `rate_limit_event`, reprise par
  `getSessionMessages`), détection (`claude --version`, `claude auth status`), SDK
  0.3.283 au catalogue avec le binaire embarqué remplacé par un paquet vide, 5 fixtures
  enregistrées (`scripts/coder/record-claude.ts`), tests de contrat, de détection et de
  conformité, parcours réel manuel `scripts/pty/coder-real.ts claude` (passé).

- **Phase 5** — `feat(coder): drive Codex through its app-server` : adaptateur
  `server/adapters/codex.ts` (JSON-RPC via `RpcPeer`, `clientInfo.name = "airtty-coder"`,
  thread par session, approbations commande / fichier / questions comme requêtes de
  Codex répondues une fois, mode `read` = sandbox lecture seule + `collaborationMode`
  plan, revue du plan final par coder, mode `edits` = fichiers acceptés d'office,
  limites par `account/rateLimits/updated`, skills comme commandes), types générés
  (`scripts/coder/codex-types.ts`, 196 fichiers, exclus du lint et du format),
  5 échanges enregistrés (`scripts/coder/record-codex.ts`), tests de contrat « pas à
  pas », détection (`codex --version`, `codex login status`), parcours réel passé.

- **Phase 6** — `feat(coder): drive pi with an approval gate` : adaptateur
  `server/adapters/pi.ts` (`pi --mode rpc --session-id … --no-approve -e <gate>
--coder-mode <mode>`, lignes JSON validées, deltas puis `message_end` qui fait foi,
  fin de tour sur `agent_settled`, statistiques de session pour le contexte et le coût,
  reprise par `get_messages`, sessions listées en lisant les en-têtes du dossier de
  pi), extension d'approbation `server/pi-gate.ts` (JS embarqué, écrit en fichier privé
  au démarrage ; échoue fermé), garde-fou Anthropic `server/anthropic-guard.ts`
  (environnement, `pi auth check`, type et préfixe via `jq`, jamais une valeur),
  4 échanges enregistrés, tests de contrat, de la gate (matrice mode × outil × réponse),
  du garde-fou et de la détection ; parcours réel passé.

- **Phase 7** — `feat(coder): drive opencode through its server` : adaptateur
  `server/adapters/opencode.ts` (un `opencode serve --hostname=127.0.0.1 --port=0` par
  session, mot de passe aléatoire en Basic auth, `share: "disabled"` ajouté à la
  configuration, `x-opencode-directory` ; tours par `prompt_async` suivis sur `/event`,
  fin sur `session.idle` ; parts `text` / `reasoning` / `tool` / `step-finish` /
  `compaction` ; `permission.asked` → approbation, `question.asked` → question ; modes =
  règles de session posées à la création et par `PATCH`, `read` lance l'agent `plan` ;
  commandes par `/session/{id}/command` ; reconnexion du flux avec rattrapage par
  `/session/status`, `/permission`, `/question`), garde-fou Anthropic
  (`opencodeAnthropicOAuth` : type d'`auth.json` via `jq`, `OPENCODE_AUTH_CONTENT`,
  méthode oauth `anthropic` de `/provider/auth`, plugin `/anthropic|claude/i` de
  `/config` ; vérifié au démarrage, au choix du modèle et avant chaque prompt),
  détection (`opencode --version`, `opencode auth list`), 6 échanges enregistrés
  (`scripts/coder/record-opencode.ts`, modèle gratuit OpenCode Zen), 14 tests de
  contrat, parcours réel passé.

## Reste

Rien du handoff. Pistes v2 (spec §9) : `/rewind`, `/fork`, `!`, tiroir diff, images,
injection pendant un tour pour opencode (`/api/*` « v2 » d'opencode, encore
expérimental).

## Décisions prises en cours de route

- **Parseur maison** conservé (≈ 330 lignes avec la documentation) : pas de bascule
  vers cleye.
- L'empreinte des arguments ne contient **pas** le cwd : les chemins `kind: "path"` sont
  déjà absolus ; le cwd entre dans la clé seulement pour `per-directory` / `per-launch`.
- `--on` : les arguments partent sans cwd ; le Server distant résout les chemins contre
  son propre répertoire (le home ssh). La réclamation d'orphelin se fait localement,
  sans interroger le Server distant : s'il est mort, la relance en démarre un neuf avec
  le même id (route et champs restaurés, état métier perdu). `per-directory` avec `--on` :
  le cwd local entre dans la clé.
- `--web-local` : pas d'arguments en v1 (valeurs par défaut du schéma).
- Erreurs d'usage reconnues par `exitCode === 2` (et non `instanceof`) : le lanceur
  importe la copie bundlée d'`args.ts` de l'application.
- Le parcours PTY per-launch est un script à part (`scripts/pty/launches.ts`, petite app
  générée) : Notes est `shared` et doit le rester.
- Adaptateurs : ils **émettent** par un callback `emit` fourni à la construction plutôt
  qu'un `events(): AsyncIterable` (un seul consommateur, rien à fermer). La session
  ajoute elle-même l'item « user » à l'envoi ; un adaptateur ne l'émet que dans un
  historique repris.
- Flux : snapshot puis patchs par **révisions** (chaque item et chaque champ porte la
  sienne ; un abonné envoie ce qui est plus récent que ce qu'il a vu), 50 ms au plus,
  400 items au plus. `seq` par abonnement ; un trou côté Client rouvre le flux.
- File d'attente tenue par la session pour tous les harnesses (⌥⏎, ou ⏎ pendant un tour
  si le harness ne sait pas injecter), envoyée à la fin du tour.
- `harness: "fake"` fait partie de l'enum de `--harness` (démo scriptée, documentée).
- Cible web : `build --web-local` de coder se construit (harness factice) ; pas exécutée
  dans un navigateur dans cette session.

- Claude : le SDK **termine son itérateur par une erreur** après un résultat en erreur
  (refus avec `interrupt`, interruption) — observé sur le vrai binaire. L'adaptateur
  rouvre alors une requête sur le même id de session (`resume`), au plus une fois sans
  message reçu entre-temps, sinon `exited`.
- Claude : fixtures enregistrées avec `settingSources: []`, sans messages de hooks et
  avec des listes réduites : elles sont publiques et ne doivent rien porter de
  l'environnement de l'utilisateur. coder, lui, charge `["user","project","local"]`.
- Claude : la détection n'ouvre pas de `query()` sans prompt (T3) : le démarrage de la
  session le fait déjà (`initializationResult()` → modèles, commandes, compte).
- Le marqueur `import "server-only"` est retiré des modules sous `server/` : le
  répertoire suffit (docs/BOUNDARIES.md) et le marqueur empêchait de les importer dans
  `bun test`.

- Codex : la revue de plan n'est pas une requête de Codex (le mode plan finit par un
  item `plan`) : coder ouvre sa propre revue ; approuver repasse en `ask` et envoie
  « Implement the plan. », refuser avec un retour l'envoie comme message.
- Codex : les demandes que coder ne sait pas traiter (élicitations MCP, permissions
  supplémentaires, outils dynamiques) sont refusées avec un avis dans le transcript.

- pi : `--no-approve` par défaut (les ressources de projet `.pi/` exécutent du code ;
  elles restent à approuver dans le pi de l'utilisateur). Le mode `read` passe
  `--tools read,grep,find,ls` au lancement **et** la gate le fait respecter ; changer de
  mode passe par la commande de la gate `/coder-mode <mode>` (aucun appel au modèle,
  vérifié sur le vrai binaire).
- pi : les dialogues `input` / `editor` d'autres extensions sont annulés avec un avis
  (le dialogue de question de coder ne propose que des options).
- Garde-fou Anthropic : sans `jq`, seuls l'environnement et `pi auth check` sont
  consultés (les tests qui en dépendent sont sautés sans `jq`).

- opencode : `fetch` + SSE écrits à la main plutôt que `@opencode-ai/sdk` : une
  douzaine de routes, chaque réponse validée par Zod de toute façon ; le SDK aurait
  ajouté une dépendance et son client généré pour un typage dont coder ne se sert pas.
- opencode : si l'utilisateur fournit déjà `OPENCODE_CONFIG_CONTENT`, sa configuration
  est **gardée** et seul `share: "disabled"` y est ajouté (le handoff dit de ne pas
  l'écraser ; le partage public doit rester coupé dans tous les cas).
- opencode : pas d'injection pendant un tour (`steer: false`) : un prompt envoyé pendant
  un tour est mis en file par coder et part à la fin.
- opencode : fixtures enregistrées avec `opencode/mimo-v2.6-flash-free` (gratuit) : les
  clés OpenAI / Google de cette machine n'avaient pas de crédit ; `error.jsonl` garde
  l'échec de crédit OpenAI comme scénario d'erreur.

## Écarts avec le handoff et la spec

- **Codex 0.157.0, pas 0.156.1** : le profil Nix de l'utilisateur a mis `codex` à jour
  pendant la session. Les types sont générés depuis le binaire installé (0.157.0) ;
  l'adaptateur signale une autre version au démarrage. Les échanges enregistrés datent
  de ce passage (version non conservée par le premier enregistreur ; il la garde
  désormais dans `userAgent`).

- **Grammaires tree-sitter non ajoutées** (handoff §6). Vérifié sur OpenTUI 0.5.12 : un
  bloc de code d'un langage sans grammaire s'affiche en texte brut, pas vide (#1494 ne
  se reproduit pas avec un `syntaxStyle`), même quand une grammaire enregistrée est
  injoignable. En ajouter imposerait des téléchargements à l'exécution depuis des URL
  que je n'ai pas pu vérifier (réseau refusé dans cette session).
- **Ctrl+C quitte au premier appui** (comportement du framework), pas ×2 (spec §6).
- Pas encore de `/rewind`, `/fork`, `!`, tiroir diff, images : v2 selon la spec §9.

## Environnement du worktree

`bun install --frozen-lockfile` à la racine **et** dans `website/`, puis
`bunx astro sync` dans `website/` : sans cela `bun run lint` échoue sur les types du site.

## Bilan

- Branche `feat/coder`, non fusionnée, non poussée. Phases 0 à 7 livrées, chacune par un
  commit atomique ; `bun run verify` vert avant chaque commit significatif (dernier
  passage : 387 tests réussis, 0 échec).
- Quatre harnesses réels pilotés (Claude Code, Codex, pi, opencode) plus le harness
  factice ; chacun a passé le parcours réel sur PTY (`scripts/pty/coder-real.ts`) :
  réponse, dialogue d'approbation, fichier écrit, aucun processus orphelin.
- Garde-fous du §3 vérifiés par `tests/coder-compliance.test.ts` (aucun fichier de
  secrets, aucun endpoint OAuth, binaire `claude` de l'utilisateur, nom de client
  Codex, serveur opencode verrouillé et sans partage) et par les tests de garde-fou
  Anthropic (pi et opencode).
- Pour reprendre : `bun install --frozen-lockfile` (racine et `website/`), `bunx astro
sync` dans `website/`, puis `bun run coder -- --harness fake` pour la démo.
