# Style guide for the docs

This guide is the standard for every page under `website/src/content/docs/` and for the
`README.md`. A rewrite follows it, and a review judges against it. Each rule has a bad example
quoted from a page, with its `path:line`, and the same text rewritten. Paths are relative to
`website/src/content/docs/`, and line numbers are those of 2026-10-04.

The rules marked **lint** are checked by `bun website/scripts/prose-lint.ts`, which the test
suite runs (`tests/docs-prose.test.ts`). The others are checked by the reviewer.

## Rules

### 1. One idea per sentence

At most one colon or one semicolon per sentence, never both, and at most 30 words. **lint:**
`chained-clauses`, `long-sentence`.

- Bad (`getting-started.mdx:54-56`): "The route, the history and the text of named fields come
  back; state held only in memory does not: there is no Fast Refresh."
- Good: "The route, the history and the text of named fields come back. State held only in
  memory is lost: there is no Fast Refresh."

### 2. A paragraph holds 60 words at most

Past 60 words, cut the paragraph in two or turn it into a list. **lint:** `long-paragraph`.

- Bad (`concepts/cache.mdx:100-104`, 75 words): "During `GET /render`, every cached read (hit
  or miss) adds its tags to the render's, those of async Server Components under `Suspense`
  included. The tags travel in the Flight stream, after the page. The Client remembers the
  tags of each loaded tree; on a tag invalidation it revalidates …"
- Good: "Each render records the tags of the cached reads it made, in async Server Components
  too. The tags reach the Client after the page.

  When a tag is invalidated, the Client reloads two kinds of routes: those that read the tag,
  and those whose tags it does not know yet."

### 3. The rule first, then the reason, then the example

A paragraph opens with what the reader gets or must do. Conditions and reasons follow, and
the Notes example comes last.

- Bad (`guides/opening-an-app.mdx:116-121`): "**If the connection drops** while the Client
  lives, its pings fail and it shows "Disconnected". The tunnel is relaunched after 1 s, 2 s,
  4 s… up to 30 s, … Conditions: key or agent authentication (…), and the Server still in its
  grace period."
- Good: "The Client reconnects by itself when SSH logs in with a key or an agent and the
  Server is still in its grace period. It retries after 1 s, 2 s, 4 s, up to 30 s. After a
  password-only login, relaunch the Client."

### 4. The first paragraph says what the page gives

Subject and verb come first. The page's job is in its first sentence, not its history or its
ingredients.

- Bad (`concepts/cache.mdx:15`): "Inspired by the Cache Components of Next.js 16 and reduced
  to what a terminal Client uses: **data reads** cached on the Server, tagged, …"
- Good: "`"use cache"` keeps the result of a Server read. Invalidating one of its tags purges
  it, and the Client reloads only the routes that read that tag."

### 5. Parallel items are a list, items with attributes a table

Three or more parallel items are a list. Items with two or more attributes each are a table.

- Bad (`concepts/routing.mdx:50-52`): "The build fails, naming the files, on two pages with the
  same URL once groups are removed, two equivalent dynamic patterns (`/users/[id]` and
  `/users/[slug]`), a repeated param or a malformed segment."
- Good: "The build fails, and names the files, when it finds:

  - two pages with the same URL once groups are removed
  - two equivalent dynamic patterns, such as `/users/[id]` and `/users/[slug]`
  - a repeated param
  - a malformed segment"

### 6. Define a term at its first use, or do not use it

A term the reader may not know is defined in the sentence that first uses it, or linked to
the page that defines it. Otherwise, say the thing plainly.

- Bad (`concepts/client-components.mdx:32`): "`"use client"` cuts the Server's graph."
- Good: "`"use client"` marks where the Server's imports stop. The Server does not run that
  module: a page that imports it receives a reference to it."

### 7. No implementation mechanism in Concepts and Guides prose

How the framework does something (the AST, a hash, an internal file or function) goes in a
collapsible `<details>` block or in the Reference. The prose says what the reader sees and
does.

- Bad (`concepts/client-components.mdx:36-37`): "The directive is recognised only in the
  module's prologue, through the TypeScript AST; no regular expression rewrites it."
- Good: "`"use client"` counts only at the very top of the file, before any other statement."
  The AST detail moves to a `<details>` block titled "How the build finds the directive".

### 8. No personification

The subject is a real actor: the reader, the app, the Client, the Server or the build. The
verb is an event the reader can observe.

- Bad (`concepts/server-functions.mdx:62`): "The transport never claims a certainty it lacks:
  any case it does not recognise is `unknown`."
- Good: "The transport reports `unknown` for every failure it does not recognise."

### 9. Nothing essential in parentheses

A parenthesis holds an aside the reader can skip. A condition, a guarantee or a limit is a
sentence of its own. No parenthesis inside a parenthesis, and no semicolon inside one.

- Bad (`concepts/loading-and-errors.mdx:43-44`): "`error` is a `TransportError` with its
  `outcome`, or a Server render error (opaque in production)"
- Good: "`error` is a `TransportError` with its `outcome`, or a Server render error. In
  production, the Client gets a generic error in place of the Server's message."

### 10. Security and data-loss warnings go in a warning Note

A risk to the user's data or security goes in `<Note kind="warning">`, never at the end of a
list item or a paragraph.

- Bad (`concepts/session-restore.mdx:149-150`), at the end of a list item: "Another account
  that signs in first after a crash finds the previous one's text: the session belongs to the
  system user, like a browser profile."
- Good:

  ```mdx
  <Note kind="warning">
    The restored session belongs to the system user, like a browser profile. After a crash, an
    account that signs in first sees the text the previous account typed.
  </Note>
  ```

### 11. Headings name the action or the question

A heading says what the section lets the reader do, or the question it answers. A reader
who scans the headings knows where to stop.

- Bad (`guides/latency-and-faults.mdx:42`): "## Make it worse"
- Good: "## Add jitter, slow streams and faults"

### 12. A pronoun points to the noun just before it

"It", "they", "one" and "neither" point to the nearest noun. When that noun is not the one
meant, repeat the noun.

- Bad (`concepts/routing.mdx:74-75`): "There is no `<Link>`: it renders a DOM anchor."
- Good: "luciole does not re-export TanStack's `<Link>`, because `<Link>` renders a DOM
  anchor."

### 13. Plain verbs, no calques

Use the common English verb for the action. No word-for-word French ("gets the same
keeping"), no absolute construction ("the last Client gone, the Server stops"), and no
contrast with "never" where a positive sentence says it.

- Bad (`concepts/session-restore.mdx:43-44`): "A field that is neither (an editor, a canvas)
  gets the same keeping from `useRestoredField(name, value, onChange)`"
- Good: "For a field of your own, such as an editor or a canvas, call
  `useRestoredField(name, value, onChange)` to restore its text."

### 14. Write to the reader as "you"

The reader is "you". "The app" is the app's code. "The user" is the person at the terminal,
only when that person is not the reader.

- Bad (`guides/untrusted-apps.mdx:33-34`): "The user chooses the mode, remembered per origin,
  or by flag; the app never does."
- Good: "You choose the mode, with a flag or once per origin. The app cannot choose it."

### 15. Link instead of repeating another page

A rule lives on one page. Another page that needs it links there, with a sentence that says
why the reader should follow the link.

- Bad (`concepts/authentication.mdx:97`): "Never put a secret in the Client's sources or in a
  prop: both reach the terminal." The rule is already in `concepts/server-components.mdx:69-70`.
- Good: "Secrets stay on the Server: see
  [what a page cannot do](/docs/concepts/server-components/#what-a-page-cannot-do)."

### 16. One name per concept

Each concept has one name across the docs, the README and the landing page. The
[terminology table](#terminology) gives it.

- Bad (`getting-started.mdx:53`): "The dev server rebuilds and restarts both processes, and
  the client reopens the same screen"
- Good: "`bun run dev` rebuilds the app and restarts both processes. The Client reopens the
  same screen"

### 17. No blank line inside a sentence

In MDX, a blank line starts a new paragraph, even in the middle of a sentence. A line that
starts with `<kbd>`, `<code>`, `<Src` or a lowercase word after a blank line is the second
half of a cut sentence. **lint:** `split-paragraph`.

- Bad (`reference/cli.mdx:14-16`): "In a clone of the repository," then a blank line, then
  "`<code>{commands.fromClone}</code>` runs the same CLI without installing anything"
- Good: the same sentence on consecutive lines, with no blank line between them.

## Terminology

One name per concept. The "Avoid" column lists the forms found in the pages on 2026-10-04.

| Concept                                   | Write                                                                                                                       | Avoid                                                  | Why                                                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| luciole's two programs                    | **Client**, **Server**, capitalised                                                                                         | "client", "server", "the dev server", "the terminal"   | The capital marks luciole's programs; lowercase stays for the generic sense ("an HTTP client").                     |
| A function the Client calls on the Server | **Server Function**                                                                                                         | "action", "public action", "Server Reference" in prose | React's name for it. "action" appears only for the `/action` endpoint and in code names (`saveAction`, `actions/`). |
| The credential sent with each request     | **token**; at its first use on a page, "bearer token, the string the Client sends with each request to prove who signed in" | "bearer" alone, "replace a bearer"                     | It matches `setToken` and `LUCIOLE_TOKEN`; "bearer" alone reads as a person.                                        |
| What `authenticate` returns               | **sign-in session**                                                                                                         | "session" alone                                        | Two sessions exist; the qualifier says which one.                                                                   |
| What the Client keeps across restarts     | **restored session** (history, named fields, focus, scroll)                                                                 | "session" alone, "Client session"                      | It matches the page "Session restore", and "Client session" also reads as a running Client.                         |
| Text typed but not saved yet              | **unsaved text** in framework pages; **draft** only for Notes' concept, `Draft` only for Notes' type                        | "Draft", "Drafts" in framework pages                   | The framework holds no draft; a capital in a framework page suggests an API that does not exist.                    |
| The persistent part of an app's screen    | **layout**, or the part's name ("status line", "sidebar")                                                                   | "chrome"                                               | Layouts are a defined luciole concept; "chrome" is undefined jargon and collides with the Chrome browser.           |
| The framework package                     | `@luciole-sh/core`                                                                                                          | `luciole`, "the luciole dependency"                    | It is the name in `package.json`, and the one a reader installs.                                                    |
| Its entries                               | `@luciole-sh/core/<entry>`: `/client`, `/server`, `/args`, `/build`, `/dev`, `/pty`, `/sandbox`, and so on                  | `luciole/client`, `luciole/<entry>`, `@luciole/*`      | A reader copies an import from the prose; only the full specifier resolves.                                         |
| The libraries                             | `@luciole-sh/flow-graph`, `@luciole-sh/markdown-editor`                                                                     | `@luciole/editor`                                      | The published names.                                                                                                |
| Installing                                | `bunx luciole.sh init`, install name `luciole.sh`                                                                           | `bunx luciole init`                                    | `luciole` on npm is not ours; `bunx luciole` would run someone else's package.                                      |
| The command line                          | `luciole` (and `luciolex`), in code font                                                                                    | "the luciole CLI tool", `luciole.sh` as a command      | It is the command the package installs.                                                                             |
| The product                               | luciole, lowercase, also at the start of a sentence                                                                         | "Luciole"                                              | It is the project's own spelling, as the README writes it.                                                          |
| The program that embeds an app            | **host**                                                                                                                    | "host" for an SSH target                               | `@luciole-sh/core/dev` uses "host" for an embedding program.                                                        |
| The machine `--on` reaches over SSH       | **remote machine**                                                                                                          | "host"                                                 | It keeps "host" for one meaning.                                                                                    |
| The library that opens an app             | **launcher**                                                                                                                | "launcher" for the app that bare `luciole` opens       | One name per thing. Call that app "the app list", as it lists installed apps.                                       |

**lint:** `avoid-term` reports each form below in prose. Code spans, `<code>`, expressions,
URLs and the `"use client"` directives are not prose, so `saveAction`, `/action` and
`` `client` `` pass. Each line names the rows it checks. `(reviewer)` marks a row whose form
depends on meaning, which the reviewer checks, as with any form inside code. The lint refuses
a row without a line.

```avoid-term
/(?<![\w\/.@-]|\b[A-Z][A-Z0-9]+[ -]|\bweb )(client|server)s?(?![\w\/]|\.\w)/ luciole's two programs
/\b[Tt]he terminal\b/ luciole's two programs
/(?<![\w\/]|GitHub )(public )?actions?(?![\w\/])/ A function the Client calls on the Server
/\bServer (Actions?|References?)\b/ A function the Client calls on the Server
/\b[Bb]earer\b(?! token)/ The credential sent with each request
/(?<!\b(sign-in|restored|agent|coding-agent|shell|terminal|tmux|recorded|SSH) )\b[Ss]essions?\b(?! restore)/ What `authenticate` returns + What the Client keeps across restarts
/\bDrafts?\b/ Text typed but not saved yet (not in examples/notes/)
/\bchrome\b/ The persistent part of an app's screen
/\bthe luciole dependency\b/ The framework package
/(?<![\w@.\/-])luciole\/[a-z]/ Its entries
/@luciole\// Its entries + The libraries
/\bbunx luciole(?![.\w])/ Installing
/\bluciole CLI tool\b/ The command line
/\bLuciole\b/ The product
(reviewer) The program that embeds an app + The machine `--on` reaches over SSH
(reviewer) The library that opens an app
```

## Page shapes

Each page does one of the four [Diátaxis](https://diataxis.fr/) jobs, and its opening and
ending follow from that job.

| Shape     | Section   | Opens with                                                                  | Ends with                                                          |
| --------- | --------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Tutorial  | Start     | What the reader will have built at the end, and what they need first        | The result on screen, then the next tutorial or guide              |
| How-to    | Guides    | The task in one sentence, and when the reader needs it                      | How to check that it worked, then related guides and the Reference |
| Concept   | Concepts  | What the concept is and what it gives the reader, in two or three sentences | Its limits, then "See also" links to the guides and the Reference  |
| Reference | Reference | What the page lists, and the import or command that reaches it              | Nothing to conclude: the last entry, then related pages            |

In a Reference entry, give the exact import or command, the signature or flags, then
`Default: <value>.` with its unit, the errors it raises, and a short example.

## The prose lint

`bun website/scripts/prose-lint.ts [paths]` lints the given files or directories, or every
page and the `README.md` when no path is given. Each finding prints as `path:line rule`. It
skips front matter, imports, fenced code, tables, HTML blocks and component tags. It lints
the Markdown inside a component, such as a Note's text. Headings are checked for terms only.

A finding that the rule should not apply to takes an exception, with its reason, on the line
just before it:

```mdx
{/* prose-lint: allow long-sentence — the flags read as one unit */}
```

In a `.md` file, write `<!-- prose-lint: allow long-sentence — <reason> -->`. An exception
without a reason, or that silences nothing, is a finding itself.

`website/scripts/prose-allowlist.json` lists the pages that do not pass yet, each with its
count of findings. The list can only shrink. The test fails when:

- a page that is not listed has a finding
- a listed page has more findings than its count
- a listed page has fewer findings than its count, so its count must come down and lock the
  gain
- a listed page has no finding left, so it must leave the list

A mission that rewrites a page removes it from the list, or lowers its count.
