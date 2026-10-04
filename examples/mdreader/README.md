# mdreader — a Markdown reader

A reader for one `.md` file or for every `.md` file in a folder: the list on the left, the
rendered document on the right. It shows a Server that reads files and watches the disk, a
live Server Function that reloads the Client, and OpenTUI's `<markdown>` element, so the
example writes no parser.

Headings, emphasis, lists with checkboxes, quotes, colored code blocks, tables and links all
render. Folders are scanned recursively, without `node_modules` and `.git`.

## Run it

Run the example from a release of luciole, with no clone:

```sh
bunx luciole.sh example mdreader                  # the current folder
MD_PATH=docs bunx luciole.sh example mdreader     # one folder
MD_PATH=README.md bunx luciole.sh example mdreader  # one file
```

Or from a clone of the repository, at its root. The example depends on workspace packages, so
it does not start from its own folder. You need Bun 1.4.2, and `bun install --frozen-lockfile`
once. It needs no API key and no network.

```sh
bun run mdreader                       # the current folder: all the .md files of the repository
MD_PATH=docs bun run mdreader          # one folder
MD_PATH=README.md bun run mdreader     # one file
```

`bun run mdreader` is `luciole dev --app examples/mdreader`. You should see the list of
documents on the left and `README.md` rendered on the right.

The Server resolves `MD_PATH` from its working directory. The home page `/` shows `README.md`,
else `index.md`, else the first document. When a file changes, appears or disappears on disk,
the list and the open document reload, and the document keeps its scroll position.

## What to try

One of the two panes has the keys. At launch it is the list. Arrow keys choose a document, which
opens when they stop and replaces the history entry. `u` returns to where the browsing began.

Enter gives the keys to the document, and Tab or `h` gives them back. A click gives the keys to
the pane you click. The selection is bright when the list has the keys, and dim otherwise.

| In the list              | Action                                      |
| ------------------------ | ------------------------------------------- |
| `j` `k`, `↓` `↑`         | Next / previous document, opened on a pause |
| `g`, `Home` / `G`, `End` | First / last document                       |
| Enter, `→`, `l`, Tab     | Read the document                           |

| In the document             | Action                                                           |
| --------------------------- | ---------------------------------------------------------------- |
| `j` `k`, `↓` `↑`, wheel     | Scroll one line                                                  |
| Space, `PgDn` / `b`, `PgUp` | Next / previous page                                             |
| `d`, `Ctrl+D` / `Ctrl+U`    | Half a page                                                      |
| `g`, `Home` / `G`, `End`    | Top / bottom                                                     |
| `}` / `{`                   | Next / previous heading                                          |
| `t`                         | Outline: `j` `k` move the reading, Enter keeps it, Esc goes back |
| Tab, `h`, `←`               | Back to the list                                                 |

| Everywhere              | Action                                                       |
| ----------------------- | ------------------------------------------------------------ |
| `]` / `[`, or `J` / `K` | Next / previous document, preloaded, without moving the keys |
| `/`                     | Find a document by name or path; `↑` `↓`, Enter, Esc         |
| `u`                     | Back in the history                                          |
| `?`                     | All the active keys                                          |
| `Ctrl+R`                | Reload, and restart the watch if it stopped                  |
| `Ctrl+C`                | Quit                                                         |

The text is a reading column of at most 92 characters, centered in the pane. With a single
file there is no list and no search: the document fills the screen and keeps the keys. Below
96 columns, the list shows only while it has the keys.

The status line gives the section (`§`) and the position (`Top`, `Bot`, `All` or a percentage),
like a pager.

## How it is built

Open these files first:

- `server/library.ts` resolves `MD_PATH`, walks the folder, reads files (a path from the
  Client must name a `.md` file under the root) and watches the disk with `fs.watch`.
- `server/reflow.ts` joins the soft line breaks of paragraphs and lists before the text
  reaches the Client. OpenTUI draws prose as colored source, so a paragraph would otherwise
  keep the file's line breaks. Hard breaks (two spaces, or `\`) stay.
- `actions/library.ts` exposes `listDocs()` for the list and `watchLibrary()` as a live Server
  Function.
- `app/layout.tsx` and `components/Library.tsx` form the layout that stays on screen: the list,
  the search, the preloading of neighbours and the watch. Only the document pane waits for the
  Server.
- `app/page.tsx` and `app/doc/[...path]/page.tsx` show the document through
  `components/Reader.tsx`, which handles scroll, outline and the position kept per document.
- `app/loading.tsx`, `not-found.tsx` and `error.tsx` share one frame, `components/frames.tsx`.

To check the example, run `bun run test:pty:mdreader`. `scripts/pty/mdreader.ts` builds the app
and browses a temporary library in a real PTY.

## Environment variables

The Server reads both.

| Variable                | Default                     | Role                                                           |
| ----------------------- | --------------------------- | -------------------------------------------------------------- |
| `MD_PATH`               | the Server's working folder | A `.md` file or a folder. An empty value means the default.    |
| `MDREADER_HEARTBEAT_MS` | `10000`                     | Pause between two repeats of the library version; a test knob. |

## Limits

- Code highlighting: OpenTUI 0.5.12 bundles only the JavaScript, TypeScript, Markdown and Zig
  grammars. Other languages show without color.
- The outline and `{` `}` know only the top-level headings of a document, not those inside a
  list or a quote. They read the internal state of `MarkdownRenderable` (`_parseState`,
  `_blockStates`), which is typed public but prefixed. Check it at each OpenTUI upgrade.
- Links show, with underlined text and the URL in parentheses, but they do not open. That
  includes links to another `.md` file of the library.
- A library holds at most 2,000 documents and 16 levels of folders. A file over 2 MiB is
  truncated. A symbolic link to a folder is not followed.
- The watch uses a recursive `fs.watch`, verified on macOS only. Nothing reconnects it by
  itself: after a failure, press `Ctrl+R`.
- The reading position of each document lives in the Client's memory, and quitting loses it.
- Quotes are not reflowed, and neither is a list that contains a code block.

### Framework finding

A silent live Server Function does not see its Client leave. The runtime notices a closed
connection only when it writes. Without a write, Flight never calls `throw()` on the iterator.

Then the `finally` of an `async function*`, or the closing of a watcher, never runs, whether
the Client quit with `Ctrl+C` or was killed. This was verified by instrumenting the close.

The [Server Functions page](https://luciole.sh/docs/concepts/server-functions/) says the Server
stops the generator on unmount.

The example works around it. `libraryChanges()` sends the current version every 10 seconds,
which the Client ignores. It is a hand-written iterator, because an `async function*` waiting
for an event would handle `throw()` only after that event. The framework could connect the
abort of the request (`req.signal`) to the `signal` of `renderToReadableStream`.
