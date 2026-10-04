# Forge: a code forge in a terminal

Forge reviews pull requests the way a code forge does: comments, approvals, live CI checks and merge. It is the most complete luciole example. It exercises:

- routes and navigation
- sign-in with a PIN
- forms whose unsaved text survives a restart
- Server Functions whose response can be lost
- live streaming of CI logs

The Server keeps the repositories, users, sign-in sessions and audit trail in SQLite, and simulates the CI. The Client draws the screens.

## How do you run it?

```sh
bunx luciole.sh example forge
```

From a clone of the repository, run this from its root:

```sh
bun install --frozen-lockfile
bun run forge
```

`bun run forge` also imports the clone's last 8 git commits as a repository named `luciole`. To skip the import, run `bun packages/core/src/cli.ts dev --app examples/forge`.

No API key and no network are needed. The Server creates `forge.sqlite` in the current directory.

## What can you try?

Sign in with PIN `forge` as one of three users:

| User    | Role        | Can                       |
| ------- | ----------- | ------------------------- |
| `alice` | maintainer  | review, comment and merge |
| `bob`   | contributor | review and comment        |
| `carol` | reader      | read only                 |

The Inbox opens first. It lists the pull requests that wait for your review, across all repositories.

| Key                     | Where        | Action                                                     |
| ----------------------- | ------------ | ---------------------------------------------------------- |
| `?`                     | everywhere   | show every key of the screen                               |
| `i`, `1`–`9`, `u`       | everywhere   | Inbox, repository by number, back                          |
| `↑` `↓`, `j` `k`, Enter | lists        | select, open                                               |
| `/`, `s`, `n`           | lists        | filter locally, switch state, new pull request             |
| Tab, Shift+Tab          | pull request | Conversation, Files, Checks                                |
| `e`, `c`, `a`, `x`, `m` | Conversation | edit description, comment, approve, request changes, merge |
| `[` `]`, `j` `k`, `c`   | Files        | previous or next file, move by line, comment               |
| `v`, `s`, `e`           | Files        | mark file viewed, split diff, open in your editor          |
| `r`                     | Checks       | rerun the checks                                           |
| Ctrl+S, Ctrl+X, Esc     | text field   | publish, discard, leave without losing the text            |
| Ctrl+L, Ctrl+R, Ctrl+C  | everywhere   | sign out, refresh, quit                                    |

A letter is a command only while no field has focus. In a field, it is text.

### Replay a conflict from a second terminal

While a Client is open, a script acts on the same database. Run it from the clone's root, with the same `FORGE_DB` as the Server:

```sh
bun run forge:operator push payments 2
bun run forge:operator approve payments 2 bob
bun run forge:operator describe payments 2 "A new description"
bun run forge:operator lose merge
```

| Command                           | Effect                                                                |
| --------------------------------- | --------------------------------------------------------------------- |
| `push <repo> <number>`            | adds a revision, so earlier approvals go stale                        |
| `approve <repo> <number> [user]`  | approves as another user, `bob` by default                            |
| `describe <repo> <number> <text>` | edits the description, which conflicts with the Client's unsaved text |
| `lose <merge\|review\|publish>`   | commits the next such request but loses its response                  |

To see a lost response, sign in as `alice`, open `payments` #1 and press `a` to approve. Run `bun run forge:operator lose merge`, then press `m` in the Client. The merge commits, the response is lost, and the Client reports an unknown outcome. Ctrl+O reads the ledger, so the merge happens once.

## How is it built?

Open these first:

- `app/`: the routes, as files. `(public)/login` is open to everyone, and `(app)/` needs a sign-in.
- `server/forge.ts`: the domain. It validates every input with Zod before any effect.
- `server/instance.ts`: the one Forge of the Server process, and the environment variables below.
- `actions/pulls.ts`: the Server Functions that review, comment and merge.
- `components/Conversation.tsx`, `FilesReview.tsx`, `ChecksPanel.tsx`: the three tabs of a pull request.
- `components/draft.ts` and `operations.ts`: unsaved text, and the outcome of requests whose response was lost.
- `components/editor.ts`: opens a file in your editor, on the Client's terminal only.

[docs/FORGE.md](../../docs/FORGE.md) walks through the design and a five-minute demonstration.

## Which environment variables does it read?

The Server checks them at startup. A value that does not parse stops it and names the variable.

| Variable             | Default        | Effect                                                                            |
| -------------------- | -------------- | --------------------------------------------------------------------------------- |
| `FORGE_DB`           | `forge.sqlite` | SQLite file, created in the current directory. The operator reads it too.         |
| `FORGE_CI_SCALE`     | `1`            | Multiplies the duration of simulated CI runs. A smaller value is faster.          |
| `FORGE_GIT_REPO`     | none           | Git repository to import as `luciole`. `bun run forge` sets it to `.`.            |
| `FORGE_GIT_COMMITS`  | `8`            | Number of commits to import.                                                      |
| `FORGE_SLOW_MS`      | `250`          | Delay added to slow Server work, so streaming is visible.                         |
| `FORGE_CLOCK_START`  | none           | Test-only. ISO date the Server clock starts from, to freeze ages on screen.       |
| `FORGE_CI_GATE`      | none           | Test-only. File path. While the file exists, CI logs stop after their first line. |
| `VISUAL`, `EDITOR`   | `vi`           | Editor that `e` opens in Files. `VISUAL` wins.                                    |
| `LUCIOLE_LATENCY_MS` | `0`            | Simulated round trip added to every request.                                      |

## What are its limits?

- The CI is a simulation. No check runs your code.
- The PIN is `forge` for every user, so this is not an example of real credentials.
- Imported git history is a read-only snapshot: at most 40 files per commit, and files over 3,000 lines are skipped.
- `e` opens a read-only copy of the file. Forge reviews revisions and does not take local edits back.
- `forge:operator` is a script of the clone's root. It is not part of `bunx luciole.sh example forge`.

## How do you test it?

```sh
bun run test:pty:forge
bun run test:web:forge
```

- `test:pty:forge` drives the built Server and Client in a pseudo-terminal.
- `test:web:forge` drives a headless browser. It needs Google Chrome (`CHROME=` sets another path) and the web runtime, built with Zig 0.16.0 (`ZIG=` sets the path).
