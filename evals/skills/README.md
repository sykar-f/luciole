# Skill evals

A scenario asks a coding agent to do one task in a fresh luciole app. The task runs twice, and
the results go side by side:

- **without**: the app as `create-luciole` makes it, with no `.agents/skills` and no `AGENTS.md`
  block. The runner also removes `skills/` and `agents-block.md` from
  `node_modules/@luciole-sh/core`, where a search would otherwise find them: the arm holds the
  app and the package's docs, and no skill and no block anywhere;
- **with**: the same app after `luciole skills install --agent agents`.

```sh
bun run skills:eval <skill> [<scenario>…] [--runs N] [--model M]
bun run skills:eval luciole-app                  # every scenario of luciole-app, once per arm
bun run skills:eval luciole-app about-route --runs 3
```

The runner packs `@luciole-sh/core` and `@luciole-sh/markdown-editor` with `bun pm pack`, so the
docs come from `prepack` as a user receives them. It stages a starter whose dependencies are
those tarballs, installs it, and copies the app once per run. The agent is Codex
(`codex exec --json`, stdin closed), with the model `gpt-6-luna` unless `--model` names another
one. Scenarios run one at a time.

## What a run sees and writes

A live run gets a fresh random directory under
`${XDG_CACHE_HOME:-$HOME/.cache}/luciole-skills-eval/`, with `app/`, its copy of the app;
`tmp/`, its `$TMPDIR`; and `codex/`, its `$CODEX_HOME`. The store and its ancestors stay
readable so Node can resolve toolchain paths. A store beneath an unreadable root is rejected.
Every other existing store entry and the run's own `codex/` are denied by exact path. The
store itself stays read-only to the agent.

The report remains in temporary storage. After the agent ends, its app and Codex session
logs are copied into `runs/<skill>/<scenario>/<arm>-<n>/`, alongside its transcript, diff and
check logs; checks run on that report copy. The live store directory is removed afterwards.
Interrupt cleanup removes credential copies, ends live process groups and removes live store
directories, including runs interrupted while staging or returning results.

A concurrent run created after the deny list was taken is not in that list. The contamination
guard flags successful commands naming another path in the store, including relative paths,
in the without arm. This is detection rather than sandbox prevention for that late entry.

The Codex home of a run starts with a copy of the user's `auth.json`, when present; environment
authentication needs no file and starts with an empty home. There is nothing else: no
earlier session's log, no history, no memories, no user config, plugins, MCP servers or hooks.
Codex writes its state and this run's session log there, and the copy of `auth.json` is removed
when the agent ends. The agent's commands cannot read `codex/`: Codex itself uses it, outside the
sandbox.

The agent runs under a Codex permissions profile, in place of `--sandbox workspace-write`. It
needs **Codex 0.160 or later**, the version the runner was probed with: permission profiles
(`default_permissions`, `permissions.<name>.filesystem`, `:workspace_roots` and `deny`
patterns) are a beta feature of Codex, and an older Codex rejects the run. The sandbox enforces
the profile on every command the agent runs:

- **It writes** anywhere in `app/`, `.agents/` and `.git/` included, so `luciole skills` can
  refresh the material and the agent can commit, and in `tmp/`. Nowhere else: not in the
  system's `$TMPDIR`, which holds the report, and not in `/tmp`. A scratch app the agent makes
  for itself lands in `tmp/` and goes with the run.
- **It reads** the rest of the disk, as the toolchain needs, except:
  - the temporary directories (`$TMPDIR`, the user's temporary directory and `/tmp`), which
    hold this report's bases, tarballs, report copies and other agents' scratch apps;
  - the user's Codex home (`$CODEX_HOME`, or `~/.codex`), whose session logs, history and
    memories hold the output of every earlier session, this pass's with runs included;
  - every checkout of this repository, which holds the skills' sources.
- **In the without arm**, it reads no `SKILL.md` or `agents-block.md` anywhere on disk,
  including the user's skill directories and package caches. These single-component patterns
  avoid a Codex 0.160 Seatbelt limitation: a nested global deny pattern also forbids removing
  unrelated directories, preventing tests from cleaning up their build locks.
- Reference basenames are also denied globally when the without base has no legitimate file
  of that name. Names shared with the app or its package docs remain readable, so the docs
  keep their pages. A successful command naming the skill's `references/`, or printing a
  reference's first heading and first words (even from a renamed copy), contaminates the run.
- **On the network**, it can bind and connect on loopback (`127.0.0.1` and `::1`) on any
  port, so it can run the app and its tests. Codex's managed proxy allows only `localhost`,
  `127.0.0.1` and `::1`; outside TCP connections and HTTPS fetches are refused. **Codex 0.160
  also permits direct outbound DNS on port 53**, a sandbox limitation: a run can resolve
  outside names, but cannot fetch their pages or packages. It can reach nothing else.

The report checks what the sandbox should have stopped, whatever it allowed. A without run is
**contaminated** when a command it ran exited 0 and either named the skill's SKILL.md, a file of
its `references/`, `agents-block.md` or a Codex session's log (a `rollout-*.jsonl`,
`session_index.jsonl`, `history.jsonl` or a Codex home's `sessions/`), or printed the skill's
own opening: its frontmatter's `name:` line and the first words of its description, or a
reference's first heading and first words, which a search through a renamed copy also shows. A run whose `file_change` events name a path
outside its app **wrote outside**. Both show in the table, with the commands and paths listed
under it, so a leak or a write that escaped never passes for a skill's result.

The runner measures and does not gate: it exits 0 whatever the scores. It never runs in
`bun test` or `bun run verify`, because every run costs a real agent session.

## The scenario file

A scenario is `evals/skills/<skill>/<scenario>.md`. These files live outside the package, so
they never ship into an app. The YAML frontmatter holds the checks and options, and the text
after it is the prompt, sent to the agent word for word.

```markdown
---
expect-skill: luciole-app
timeout-minutes: 15
checks:
  - exists: app/about/page.tsx
  - match:
      file: app/about/page.tsx
      pattern: About Notes
  - run: bun run verify
---

Add a page at the route `/about` that shows the text "About Notes". Keep `bun run verify`
passing.
```

This is [`luciole-app/about-route.md`](luciole-app/about-route.md).

| Field             | Required | Meaning                                                                                                                                     |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `checks`          | yes      | What must hold in the app after the agent finishes, in order. Each check is one column of the table.                                        |
| `expect-skill`    | no       | A skill name. The report then says whether the agent ran a command that names `<skill>/SKILL.md` and exited 0, that is, whether it read it. |
| `timeout-minutes` | no       | How long the agent may run before it is killed (default 15). Its checks still run.                                                          |
| `setup`           | no       | A shell command that plants a state in the app before the agent starts. See [A planted state](#a-planted-state).                            |

The checks, relative to the app's root:

| Check                                       | Passes when                                       |
| ------------------------------------------- | ------------------------------------------------- |
| `run: <command>`                            | the command exits 0 (`sh -c`, at most 10 minutes) |
| `exists: <path>`                            | the path exists                                   |
| `absent: <path>`                            | the path does not exist                           |
| `match: { file: <path>, pattern: <re> }`    | the file exists and the regex matches (multiline) |
| `no-match: { file: <path>, pattern: <re> }` | the file exists and the regex does not match      |

## A planted state

Some tasks start from an app that is not fresh: a defect to diagnose, a stale dependency, a
misused API. Telling the agent about that state in the prompt proves little, so `setup` builds
it. The command runs with `sh -c` in each run's copy of the app, in both arms, for at most 10
minutes. The runner then commits what it changed and takes that commit as the baseline. The
agent finds the planted state in the app as it is, and `diff.patch` holds only the agent's work.

`$SCENARIO_DIR` is the scenario's directory, `evals/skills/<skill>/`. A setup can copy a fixture
file that sits next to the scenario:

```markdown
---
expect-skill: luciole-debug
setup: |
  cp "$SCENARIO_DIR/fixtures/broken-page.tsx" app/page.tsx
checks:
  - run: bun run verify
---

The home page renders blank. Find out why and fix it. Keep `bun run verify` passing.
```

A setup that exits non-zero or runs out of time is not an agent result: the agent does not
start, the checks do not run, and the report shows `setup failed` for that run. The setup's
output goes to `setup.log`.

## The report

The runner prints the directory it writes to first, then one table: a row per scenario, arm and
run, with `pass` or `FAIL` for each check (`c1`, `c2`… are listed under the table), whether the
expected skill was read, whether a without run was contaminated (`YES`, `no`, or `-` in the with
arm), whether the agent wrote outside its app, how the agent ended (`ok`, `timeout`, `exit N`, or `setup failed`
when it never started), and the duration. When the agent leaves processes that no signal can
end (macOS may refuse one with EPERM), the run still completes and its outcome says so, as in
`ok, cleanup: 1 left`.

The directory holds, for each run under `runs/<skill>/<scenario>/<arm>-<n>/`:

- `setup.log`: the setup's output, when the scenario has one;
- `transcript.jsonl`: the agent's events (`codex exec --json`);
- `diff.patch`: everything the agent changed, against the app as it found it, setup included;
- `checks.log`: each check's output;
- `app/`: the app after the run;
- `codex/`: the run's Codex home, with its credential copy removed.

The live run's `tmp/` is removed with the store root and is not copied into the report.

`report.md` at the root holds the table. It is written again after each run, so a pass that
stops early keeps the rows of the runs it finished.
