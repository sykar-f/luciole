# État d'avancement — `examples/coder`

Branche `feat/coder`. Référence : [CODER-HANDOFF.md](../CODER-HANDOFF.md) (prime),
[SPEC.md](SPEC.md).

## Phase en cours

Phase 3 — squelette `examples/coder`, harness factice, UI.

## Fait

| Phase | Commit                                  | Résumé                                                                                                                                                                                                                                                                     |
| ----- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| —     | `docs(coder): format the handoff…`      | Les notes du handoff n'étaient pas passées par oxfmt : `verify` échouait.                                                                                                                                                                                                  |
| 0     | `fix(build): lock concurrent builds…`   | Verrou `mkdir` `.airtty-lock` ; build sauté si buildId + options identiques ; `package.json`, `airtty.json` et l'icône entrent dans le buildId.                                                                                                                            |
| 1     | `feat(args): let applications declare…` | `airtty/args` (`defineArgs`, parseur maison sur Standard (JSON) Schema), `app/args.ts` bundlé dans `.airtty/args`, JSON Schema dans `metadata.json`, `AIRTTY_ARGS`, entrées dev / lanceur / binaire / `serve --` / `start --` / `--on` (stdin), code de sortie 2, docs FR. |

## Reste

- Phases 3 à 7 : `examples/coder` (factice + UI), Claude, Codex, pi, opencode.

## Décisions prises en cours de route

- Phase 2 : le parcours PTY per-launch est un script à part, `scripts/pty/launches.ts`
  (`test:pty:launches`) avec une petite app générée, plutôt qu'une extension de
  `lifetime.ts` (Notes est `shared` et doit le rester).
- `--on` + `per-launch` : la réclamation d'orphelin se fait localement, sans pouvoir
  interroger le Server distant ; si celui-ci est mort, la relance en démarre un neuf avec
  le même id (route et champs restaurés, état métier perdu).
- `per-directory` avec `--on` : le cwd local entre dans la clé (un Server distant par
  projet local), le Server distant tourne dans le home ssh.
- **Parseur maison** conservé (≈ 330 lignes avec la documentation, sous la barre des
  ~300 lignes de code) : pas de bascule vers cleye.
- L'empreinte des arguments ne contient **pas** le cwd : les chemins `kind: "path"` sont
  déjà absolus ; le cwd entre dans la clé seulement pour `per-directory` / `per-launch`.
- `--on` : les arguments sont envoyés sans cwd ; le Server distant résout les chemins
  contre son propre répertoire (le home ssh).
- `--web-local` : pas d'arguments en v1 (valeurs par défaut du schéma).
- Erreurs d'usage reconnues par `exitCode === 2` (et non `instanceof`) : le lanceur
  importe la copie bundlée d'`args.ts` de l'application.

## Écarts avec le handoff

Aucun pour l'instant.

## Environnement du worktree

`bun install --frozen-lockfile` à la racine **et** dans `website/`, puis
`bunx astro sync` dans `website/` : sans cela `bun run lint` échoue sur les types du site.
