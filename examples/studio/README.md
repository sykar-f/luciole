# studio — describe an app, use it while it is written

Studio lets you describe a luciole app to a coding agent and use that app while the agent
writes it. The conversation sits on the left, and the generated app runs on the right.

It exercises these luciole features:

- an app embedded in another, in a terminal widget
- a confined app: its Server and Client run in a sandbox
- signed builds, made beside the source
- the restored session, which keeps your place in the app across rebuilds

```text
 ● studio · demo · powered by scripted demo · r5                                                                                                              ✓
     11 -       <text id="studio-soon">A guestbook is coming…</text>            ╭─ r5 · sandbox ──────────────────────────────────────────────────────────────╮
     12 +       <Links />                                                       │                                                                             │
     13       </box>                                                            │ MY APP · Connected                                                          │
     14     );                                                                  │                                                                             │
     15   }                                                                     │ Guestbook · 30 signatures                                                   │
                                                                                │                                                                             │
  Wrote app/page.tsx, server/guestbook.ts, actions/guestbook.ts, components/    │ Guest 06: Hello from the first visitors                                     │
  Guestbook.tsx, app/guestbook/page.tsx, components/Links.tsx.                  │ Guest 07: Hello from the first visitors                                   ▀ │
                                                                                │ Guest 08: Hello from the first visitors                                     │
  • Revision r4 built and running.                                              │ Guest 09: Hello from the first visitors                                     │
                                                                                │ Guest 10: Hello from the first visitors                                     │
   › Show how many people signed the guestbook                                  │ Guest 11: Hello from the first visitors                                     │
                                                                                │                                                                             │
  Counting the signatures in the guestbook's title.                             │ Name     Ada                                                                │
                                                                                │                                                                             │
  ▾ ✎ components/Guestbook.tsx                                         +1 −1    │ Message  Hi!                                                                │
     45     return (                                                            │                                                                             │
     46       <box flexDirection="column" gap={1}>                              │                                                                             │
     47         <text id="guestbook-title" fg="#67d9bc">                        │                                                                             │
     48 -         Guestbook                                                     │                                                                             │
     48 +         Guestbook · counting signatures…                              │                                                                             │
     49         </text>                                                         │                                                                             │
     50         <ScrollBox id="guestbook-entries" name="guestbook/entries" re   │                                                                             │
     51           {entries.map((entry) => (                                     │                                                                             │
                                                                                │                                                                             │
  ▾ ✎ components/Guestbook.tsx                                         +1 −1    │                                                                             │
     45     return (                                                            │                                                                             │
     46       <box flexDirection="column" gap={1}>                              │                                                                             │
     47         <text id="guestbook-title" fg="#67d9bc">                        │                                                                             │
     48 -         Guestbook · counting signatures…                              │                                                                             │
     48 +         Guestbook · {entries.length} signatures                       │                                                                             │
     49         </text>                                                         │                                                                             │
     50         <ScrollBox id="guestbook-entries" name="guestbook/entries" re   │                                                                             │
     51           {entries.map((entry) => (                                     │                                                                             │
                                                                                │                                                                             │
  Wrote components/Guestbook.tsx.                                               │                                                                             │
                                                                                │                                                                             │
  • Revision r5 built and running.                                            ▄ │                                                                             │
 ╭────────────────────────────────────────────────────────────────────────────╮ │                                                                             │
 │ › Describe the app, or a change…                                           │ │                                                                             │
 ╰────────────────────────────────────────────────────────────────────────────╯ │                                                                             │
  scripted · ✎ auto edits                      Scripted demo · no model calls   ╰─────────────────────────────────────────────────────────────────────────────╯
  Ctrl+O o app · p full · u undo · d diff · h revisions · r restart  ctrl+c quit
```

The frame of the app names what it shows:

- **a draft**, built after each file the agent writes, labelled `draft`
- **a revision**, committed after each turn, labelled `r1`, `r2`…

The screen above comes from `bun run test:pty:studio`, after two guestbook prompts. The
name and message typed in the app survived the draft and the revision.

[DESIGN.md](DESIGN.md) holds the design notes, and [HOSTING.md](HOSTING.md) a study of a
hosted studio. Both are in French.

## Run it

You need:

- Bun 1.4.2 or newer, and `git`
- macOS, for the sandboxed preview (see [Limits](#limits))
- for `-H claude` only, the `claude` binary in your `PATH`, signed in with `claude auth login`

`-H fake` runs a scripted generator instead of an agent: it needs no model and no network.
From the release:

```sh
bunx luciole.sh example studio -- -H fake
```

From a clone of the repository, at its root:

```sh
bun install --frozen-lockfile                 # once
bun run studio -- -H fake                     # the scripted generator
bun run studio -- -H claude --project todos   # Claude Code, in a named project
bun run studio -- --dir ~/apps/notes -r       # a directory, resuming its conversation
```

| Option                        | Effect                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `-H, --harness`               | `claude`, the default, or `fake`.                                                    |
| `-d, --dir DIR`               | The project directory. An empty one gets the template, and a studio project reopens. |
| `-p, --project NAME`          | A project under `$XDG_DATA_HOME/luciole/studio/NAME`. Default: a new `app-<date>`.   |
| `-r, --resume [ID]`           | Resume the project's last harness conversation, or the one named `ID`.               |
| `--preview sandbox\|process`  | Run the app in a sandbox, the default, or with your rights.                          |
| `--fixes N`                   | Automatic corrections after a failed check. Default: 2, at most 5.                   |
| `-m, --model`, `-e, --effort` | The model and its effort, as the harness names them.                                 |

> **Warning.** The agent inherits studio's whole environment, keys included, and writes in
> the project directory with your rights. `--preview process` runs the generated app with
> your rights too, outside any sandbox. Do not turn on full access, which removes the
> agent's own sandbox, in another harness that runs on the same directory.

With `-H claude`, each turn uses the quota of your own subscription or key. Each automatic
correction is one more turn. Studio never calls a model itself: it drives the `claude` binary you
installed, and reads no secret. The licence of Anthropic's Agent SDK is not OSI-approved:
it allows personal, non-commercial use.

## Try it

With `-H fake`, send these two prompts:

1. "Add a guestbook page with a form to sign it." The generator writes the page in four
   steps, 1.5 s apart, and the app switches to a draft after each one.
2. "Show how many people signed the guestbook." The generator changes the page.

Between the two, press `Ctrl+O` `o` to reach the app, then `g` to open the guestbook. Type
a name, move with `Tab` and scroll the list with `PageDown`. Your text, the focus and the
scroll survive every draft.

`Ctrl+O` is the only key studio keeps. Every other key goes to the focused pane, so
`Ctrl+C` in the app reaches the app.

| Keys              | Action                                                         |
| ----------------- | -------------------------------------------------------------- |
| `Ctrl+O` then `o` | Switch between the conversation and the app. A click does too. |
| `Ctrl+O` then `p` | Show the app full screen.                                      |
| `Ctrl+O` then `r` | Restart the app: the same revision, with a new Server.         |
| `Ctrl+O` then `u` | Go back to the previous revision, as a new revision.           |
| `Ctrl+O` then `d` | Show what the revision on screen changed.                      |
| `Ctrl+O` then `h` | List the revisions. Choosing one restores it.                  |
| `Esc`             | Interrupt the harness's turn.                                  |

Type these commands in the conversation:

| Command       | Effect                                                                  |
| ------------- | ----------------------------------------------------------------------- |
| `/allow HOST` | Let the app reach `HOST`. Studio writes it in the app's `package.json`. |
| `/deny HOST`  | Take that permission back.                                              |
| `/restore N`  | Restore revision `N`.                                                   |
| `/restart`    | Restart the app.                                                        |
| `/revisions`  | List the revisions.                                                     |

## How it is built

After each turn, studio checks the work in this order:

1. **Guard.** The changed files must be `.ts` or `.tsx` files under `app/`, `components/`,
   `server/` or `actions/`, and import only the allowed packages. `STUDIO.md`, in the
   project, lists them. Studio undoes a refused turn.
2. **Build.** Studio builds the app in `.luciole-studio/builds/`, signed with the project's
   own key.
3. **Server.** The app's Server starts in a sandbox. It reads its build and writes `data/`.
   It reaches only the hosts you allowed, and starts no program.
4. **Revision.** Studio commits the turn in the project's git repository, as the `studio`
   author, never as you. The app switches to the new revision.
5. **Types.** `tsc` checks the types beside the app, without holding it back.

A failure goes back to the harness as a `[studio]` message with its file, line and error.
Studio sends at most `--fixes` corrections in a row, and never two for the same failure.

The harness gets studio's instructions and the file tools only: `Read`, `Write`, `Edit`,
`Glob`, `Grep`. It gets none of your settings, such as hooks or MCP servers. Studio refuses
every command the harness asks to run.

Open these files first:

| File                          | What it holds                                                        |
| ----------------------------- | -------------------------------------------------------------------- |
| `app/args.ts`                 | The options, declared with zod.                                      |
| `components/StudioScreen.tsx` | The screen: conversation, app pane, revisions, keys and commands.    |
| `components/Preview.tsx`      | The app pane, which runs the app's Client in a terminal widget.      |
| `actions/studio.ts`           | The Server Functions the screen calls: `send`, `respond`, `restore`… |
| `server/studio.ts`            | The loop: the harness, the drafts, the checks, the revisions.        |
| `server/drafts.ts`            | When to build a draft: one at a time, and a newer write wins.        |
| `server/guard.ts`             | The allowed paths and imports, and the advice on unnamed fields.     |
| `server/preview.ts`           | The signed build, the sandboxed Server, and `tsc`.                   |
| `server/generator.ts`         | The scripted generator, which writes the files `scenarios.ts` holds. |
| `template/`                   | The starting project, embedded in `server/template.gen.ts`.          |

After you change `template/`, run `bun examples/studio/scripts/template.ts` to regenerate
`server/template.gen.ts`. A test checks that it is up to date.

The tests, then the drafts in a real terminal, in `sandbox` and in `process` mode:

```sh
bun test tests/studio-project.test.ts tests/studio-scenarios.test.ts tests/studio-drafts.test.ts tests/studio.test.tsx
bun run test:pty:studio
```

## Environment variables

| Variable               | Default          | Effect                                                            |
| ---------------------- | ---------------- | ----------------------------------------------------------------- |
| `STUDIO_HARNESS`       | `claude`         | The harness, as `--harness` sets it.                              |
| `XDG_DATA_HOME`        | `~/.local/share` | The projects of `--project` go in `luciole/studio/` below it.     |
| `STUDIO_FAKE_WRITE_MS` | `1500`           | The scripted generator's pause after each write of a turn.        |
| `STUDIO_FAKE_DELAY_MS` | `40`             | The scripted generator's pause between the other steps of a turn. |
| `STUDIO_FAKE_GATE_DIR` | none             | A directory where tests pace the generator's drafts.              |

Studio sets these for the processes it starts:

- `STUDIO_DATA` for the app's Server: the `data/` directory, the only one it may write
- `PORT=0` for the app's Server under `--preview process`
- `GIT_TERMINAL_PROMPT=0` for `git`, so that it never asks for a password

## Limits

- The sandboxed preview needs macOS. On Linux, the Client sandbox exists but the Server
  sandbox does not yet, so studio refuses `--preview sandbox` there. Without a sandbox,
  studio does not start the app and says why.
- Studio drives Claude Code only. It cannot stop Codex from running commands, so Codex, pi
  and opencode stay in the coder example.
- A rebuild keeps the restored session and `data/`: the route, the history, named fields,
  the focus and the scroll. The rest of the app's memory is lost.
- A field without a `name` cannot be restored. Studio gives advice for it, never a refusal.
- A failed draft keeps the last screen that worked, and its frame reads
  `draft · waiting for a build that works`.
- Studio was measured once on Claude Code, on 27 September 2026, before drafts existed.
  8 of 13 prompts were right at the first try, and 13 of 13 after at most two corrections.
  [The raw results](measures/claude-2026-09-27.json) give the times and costs.
- The 5 first-try failures came from studio's template and guard. They are fixed, but the
  run was not measured again.
