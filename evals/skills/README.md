# Skill evals

A scenario asks a coding agent to do one task in a fresh luciole app. The task runs twice, and
the results go side by side:

- **without**: the app as `create-luciole` makes it, with no `.agents/skills` and no `AGENTS.md`
  block;
- **with**: the same app after `luciole skills install --agent agents`.

```sh
bun run skills:eval <skill> [<scenario>…] [--runs N] [--model M]
bun run skills:eval luciole-app                  # every scenario of luciole-app, once per arm
bun run skills:eval luciole-app about-route --runs 3
```

The runner packs `@luciole-sh/core` and `@luciole-sh/markdown-editor` with `bun pm pack`, so the
docs come from `prepack` as a user receives them. It stages a starter whose dependencies are
those tarballs, installs it, and copies the app once per run. The agent is Codex
(`codex exec --json --sandbox workspace-write`, stdin closed), with the model `gpt-6-luna`
unless `--model` names another one. Scenarios run one at a time.

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

| Field             | Required | Meaning                                                                                                                        |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `checks`          | yes      | What must hold in the app after the agent finishes, in order. Each check is one column of the table.                           |
| `expect-skill`    | no       | A skill name. The report then says whether the agent ran a command that names `<skill>/SKILL.md`, that is, whether it read it. |
| `timeout-minutes` | no       | How long the agent may run before it is killed (default 15). Its checks still run.                                             |

The checks, relative to the app's root:

| Check                                       | Passes when                                       |
| ------------------------------------------- | ------------------------------------------------- |
| `run: <command>`                            | the command exits 0 (`sh -c`, at most 10 minutes) |
| `exists: <path>`                            | the path exists                                   |
| `absent: <path>`                            | the path does not exist                           |
| `match: { file: <path>, pattern: <re> }`    | the file exists and the regex matches (multiline) |
| `no-match: { file: <path>, pattern: <re> }` | the file exists and the regex does not match      |

## The report

The runner prints the directory it writes to first, then one table: a row per scenario, arm and
run, with `pass` or `FAIL` for each check (`c1`, `c2`… are listed under the table), whether the
expected skill was read, how the agent ended (`ok`, `timeout`, `exit N`), and the duration.

The directory holds, for each run under `runs/<skill>/<scenario>/<arm>-<n>/`:

- `transcript.jsonl`: the agent's events (`codex exec --json`);
- `diff.patch`: everything the agent changed, against the app as it found it;
- `checks.log`: each check's output;
- `app/`: the app after the run.

`report.md` at the root holds the table.
