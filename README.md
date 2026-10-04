<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="website/public/mascot/readme-light.png" />
    <img src="website/public/mascot/readme-dark.png" width="172" height="226" alt="The luciole mascot: a pixel-art firefly hugging its glowing lantern" />
  </picture>
</p>

# luciole

Build terminal apps with React. Typing and scrolling stay local; the Server keeps
the data and runs model calls.

luciole is a React Server Components framework for the terminal. Pages render on a
Server and reach a separate Client as a React Flight stream; the Client draws them
with [OpenTUI](https://github.com/anomalyco/opentui). Typing, scrolling and hover are
handled on the Client, without a round trip to the Server
([`tests/latency.test.tsx`](tests/latency.test.tsx) checks this under 500 ms of
simulated latency). Navigation uses TanStack Router.

```text
 ╭───╮╭──────────────────────────╮╭───╮
 │ ≡ ││ ⌕ Search                 ││ + │
 ╰───╯╰──────────────────────────╯╰───╯
                                              Welcome to Notes                                                                        ⋯
 ╭───────────────────────────────────╮ █
 │ Welcome to Notes               ⋯  │ ▀      Notes are written in Markdown and kept in SQLite on the Server.
 │ Sep 23    Notes are written in M… │
 ╰───────────────────────────────────╯      𜶪 Getting around
 ╭───────────────────────────────────╮
 │ Shopping list                     │        • Click anywhere in a note and write: Markdown turns into what it means as you type it
 │ Sep 23    Coffee beans            │          (**bold**, # title, - list)
 ╰───────────────────────────────────╯        • Click a title to rename its note
 ╭───────────────────────────────────╮        • +, beside the search, starts a blank note; the search box filters them all
 │ Markdown, the whole spec          │        • ≡ folds the list away, and brings it back
 │ Sep 22    Every construct of Com… │        • Hover a note in the list for its menu, or right-click it
 ╰───────────────────────────────────╯
 ╭───────────────────────────────────╮                                                                                             ts
 │ Math, as GitHub writes it         │        // What the list on the left reads, cached until a save invalidates it
 │ Sep 21    Math as GitHub writes … │        export async function notesOf(owner: string) {
 ╰───────────────────────────────────╯          cacheTag(notesTag(owner));
 ╭───────────────────────────────────╮          return listNotes(owner);
 │ Trip to Lisbon                    │        }
 │ Sep 21    Book flights            │
 ╰───────────────────────────────────╯
 ╭───────────────────────────────────╮        ▎ Changes are saved on their own, a moment after you stop typing.
 │ Weekly sync — decisions and acti… │
 │ Sep 20    Attendees: Ana, Karim,… │
 ╰───────────────────────────────────╯
 ╭───────────────────────────────────╮
 │ Release 1.4                       │
 │ Sep 19    title: Release 1.4      │
 ╰───────────────────────────────────╯
 ╭───────────────────────────────────╮
 │ Snippets                          │
 │ Sep 18    Things I keep looking … │
 ╰───────────────────────────────────╯
 ╭───────────────────────────────────╮
 ──────────────────────────────────────
  13 notes
```

_Notes, the example this page walks through, in a 140×40 terminal. This frame is
captured from a real PTY by [`scripts/pty/notes-frame.ts`](scripts/pty/notes-frame.ts)._

> **Status: experimental, version 0.x.** luciole is published on npm. Its documentation
> is at **<https://luciole.sh/docs/>**. Until 1.0, a minor release may break the API. Each
> break is listed in the [CHANGELOG](CHANGELOG.md) and marked **Breaking**. What is tested
> and what is not: <https://luciole.sh/status/>.

## Get started

You need [Bun](https://bun.sh) 1.4.2 or newer, on macOS or Linux.

### Create an app

```sh
bunx luciole.sh init my-app
cd my-app
bun install
bun run dev
```

`bun run dev` builds the Server and the Client, starts both and opens the app in your
terminal. Ctrl+C quits and restores the terminal. The same steps, explained, are in
[Getting started](https://luciole.sh/docs/getting-started/).

The two libraries install on their own: `bun add @luciole-sh/flow-graph` and
`bun add @luciole-sh/markdown-editor`.

### Try it without creating anything

Clone the repository to run Notes, with no login and no API key:

```sh
git clone https://github.com/sykar-f/luciole.git
cd luciole
bun install --frozen-lockfile
bun run dev
```

`bun run dev` runs Notes from `examples/notes`.

- It creates `notes.sqlite` in the current directory, with sample notes.
- It opens on "No note selected". Click "Welcome to Notes" in the list, then click in
  the note and write.
- Ctrl+C quits and restores the terminal.

To feel what stays local, add a simulated round trip of 500 ms to every request:

```sh
LUCIOLE_LATENCY_MS=500 bun run dev
```

Search, typing, scrolling and hover stay instant. Opening another note waits for the
Server and shows a loading state. Saves are silent: Notes mentions a save only when it
takes more than 3 s, so typing alone shows no delay.

## Your first app

`init` copies Notes, a Markdown notebook kept in SQLite. Notes is a full app, not a
minimal starter: read it, then cut what you do not need.

An app has four folders:

- `app/`: the routes. Pages render on the Server.
- `components/`: Client Components, marked `"use client"`. They draw and handle input.
- `actions/`: Server Functions, marked `"use server"`. The Client calls them.
- `server/`: code that only the Server runs, such as the SQLite database.

Opening a note follows one path. The page
[`app/notes/[id]/page.tsx`](examples/notes/app/notes/[id]/page.tsx) reads the note on
the Server and hands it to a Client Component:

```tsx
export default async function Page({ params }: { params: { id: string } }) {
  const note = await noteOf(getSession().userId, params.id);
  if (!note) notFound("Note");
  return (
    <NoteEditor
      key={note.id}
      initialNote={note}
      saveAction={saveNote}
      resolveAction={getOperation}
      autosaveMs={autosaveMs}
    />
  );
}
```

[`components/NoteEditor.tsx`](examples/notes/components/NoteEditor.tsx) runs on the
Client. Each keystroke changes local state, and no request is sent:

```tsx
"use client";
// …
export function NoteEditor({ initialNote: note, saveAction, resolveAction, autosaveMs }: Props) {
  const { draft, edit, save, recover, discard, adopt } = useDraft(note);
  // …
  <MarkdownEditor
    value={draft.value}
    onChange={(markdown) => {
      typed(markdown);
      edit(markdown);
    }}
    // …
  />
```

A moment after the last keystroke, the editor calls `saveNote`, a Server Function in
[`actions/notes.ts`](examples/notes/actions/notes.ts). It writes the note through
[`server/repository.ts`](examples/notes/server/repository.ts) into SQLite:

```ts
"use server";
export async function saveNote(snapshot: Snapshot): Promise<SaveResult> {
  const input = SnapshotInput.parse(snapshot);
  // …
  const result = save(input);
  if (result.ok) await changed(result.note.id);
  return result;
}
```

## How it works

An app runs as two processes. The build decides which code goes where.

```text
 Server process                              Client process (your terminal)
┌──────────────────────────────┐            ┌──────────────────────────────────┐
│ app/      pages render here  │  pages, as │ components/  "use client"        │
│ actions/  Server Functions   │ ─ Flight ─▶│ OpenTUI draws the screen         │
│ server/   SQLite, cache      │            │ typing, scrolling and hover:     │
│ API keys, model calls        │ ◀─ calls ─ │   no round trip                  │
└──────────────────────────────┘  Server    └──────────────────────────────────┘
                                  Functions
```

The Client asks the Server for two things only: a page to show, and a Server Function
to run. Everything else happens on the Client.

Read more in [Client and server](https://luciole.sh/docs/concepts/client-and-server/).
The design note behind it is [docs/BOUNDARIES.md](docs/BOUNDARIES.md) (French).

## Run an example

The examples are not published on npm. They live in this repository, at the git tag of
the installed release (`v<version>`).

From an installed release, the launcher asks you to trust the repository (`--yes`
accepts):

```sh
bunx luciole.sh example           # lists the examples of this release
bunx luciole.sh example notes     # Notes: cloned, installed from the lock, built and run
```

The examples are `agent`, `chat`, `coder`, `files`, `flow`, `latency`, `mdreader`, `mux`,
`notes` and `studio`. Only `example <name>` expands to the repository: a bare
`luciole notes` is an npm package name, and `notes` there is not ours.

From a clone (see [Work on luciole from a clone](#work-on-luciole-from-a-clone)), run them
from the root:

| Command                                                                          | Example                                                             |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `LUCIOLE_LATENCY_MS=500 bun packages/core/src/cli.ts dev --app examples/latency` | A text field, a hover zone and a list stay local; a ping is slow    |
| `CHAT_DEMO=1 bun run chat`                                                       | AI chat with a scripted offline model (no API key)                  |
| `bun run agent`                                                                  | A coding agent UI for `pi` (needs `pi`, signed in)                  |
| `bun run coder -- --harness fake`                                                | A coding agent session; `fake` is scripted and offline              |
| `bun run files`                                                                  | File explorer of the current directory                              |
| `bun run mdreader`                                                               | Markdown reader for the `.md` files of the current directory        |
| `bun run mux`                                                                    | Local programs side by side, each on its own PTY                    |
| `bun run studio -- -H fake`                                                      | Describe an app, watch it written and running (scripted)            |
| `bun run flow`                                                                   | A CI pipeline on a node canvas (`@luciole-sh/flow-graph`), run live |

The `chat`, `agent`, `coder` and `studio` examples talk to real models or coding agents once
configured; see their READMEs in [`examples/`](examples/).

## Read the documentation

The documentation is at **<https://luciole.sh/docs/>**, in English. Start there.

The `docs/` folder holds the maintainers' design notes. They are in French and record
why the code is the way it is. Read them in this order:

1. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): repository layout and runtime roles.
2. [docs/API.md](docs/API.md): public API.
3. [docs/BOUNDARIES.md](docs/BOUNDARIES.md): what may run on the Client and on the Server.
4. [docs/ROUTER.md](docs/ROUTER.md): navigation and layouts.

Then, by topic:

- [docs/DEVTOOLS.md](docs/DEVTOOLS.md): requests, components, logs and network conditions.
- [docs/CACHE.md](docs/CACHE.md): the `"use cache"` Server cache and tag invalidation.
- [docs/EMBEDDING.md](docs/EMBEDDING.md): the generic Client and embedded apps.
- [docs/WEB.md](docs/WEB.md): the Client and the Server in a browser.
- [docs/TOOLING.md](docs/TOOLING.md): TypeScript, Oxlint and Oxfmt.
- [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md): builds, binaries and the generic Client.
- [docs/VALIDATION.md](docs/VALIDATION.md): what is tested, and the known limits.

## Work on luciole from a clone

To work on luciole itself, run it from a clone. The steps to clone it and run Notes are in
[Try it without creating anything](#try-it-without-creating-anything).

To create an app that links your clone's packages:

```sh
bun packages/core/src/cli.ts init ../my-app
```

Check your changes:

```sh
bun run verify:fast    # types, lint, format, and the tests your change reaches
bun run verify         # types, lint, format, tests and build
```

[CONTRIBUTING.md](CONTRIBUTING.md) has the checks and the commit rules. Cutting a
release is described in [docs/RELEASING.md](docs/RELEASING.md) (French).

## What runs where

- **The `luciole` CLI and development require [Bun](https://bun.sh)** 1.4.2 or newer
  (`engines` in `packages/core/package.json`; CI runs 1.4.2). luciole uses
  `Bun.Terminal`, `Bun.serve`, `Bun.build` and `bun:sqlite`, among others.
- **`@luciole-sh/flow-graph` and `@luciole-sh/markdown-editor` have no Bun dependency.**
- **A compiled Client runs without Bun.** CI tests it in Debian and Alpine containers
  ([`scripts/linux-client.ts`](scripts/linux-client.ts)).
- **Operating systems:** CI covers macOS and Linux
  ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). Windows is untested.
- **Desktop app:** `packages/desktop` is an experimental prototype for macOS arm64
  only. It is unsigned and not published (see [docs/DESKTOP.md](docs/DESKTOP.md)).

## License

[MIT](LICENSE). The `coder` and `studio` examples depend on `@anthropic-ai/claude-agent-sdk`, whose
license is not OSI-approved; see [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md).
