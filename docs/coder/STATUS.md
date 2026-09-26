# État d'avancement — `examples/coder`

Branche `feat/coder`. Référence : [CODER-HANDOFF.md](../CODER-HANDOFF.md) (prime),
[SPEC.md](SPEC.md).

## Phase en cours

Phase 4 — adaptateur Claude Code (Agent SDK).

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

## Reste

- Phases 4 à 7 : adaptateurs Claude, Codex, pi, opencode, avec leur détection réelle,
  leurs fixtures JSONL enregistrées et leurs tests de contrat ; garde-fous §3 testés.

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

## Écarts avec le handoff et la spec

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
