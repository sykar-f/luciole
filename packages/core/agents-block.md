## luciole

Your memory of luciole is likely stale or wrong: it is young, and it is neither Next.js nor
React DOM. Prefer reading the installed docs over recalling: they match this app's version.
Their index is `node_modules/@luciole-sh/core/docs/README.md`.

**Model.** A terminal app in two processes from one build. Pages are Server Components: they
render on the Server, next to the data, and stream to the Client in the terminal over React
Flight. The Client runs OpenTUI elements, keys, focus and local state. `app/` is the route tree
(`page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`, `not-found.tsx`); `actions/` holds
`"use server"` modules; `server/` is Server-only code (data, `"use cache"` reads, `auth.ts`);
`components/` holds Client Components. `bun run verify` (types, lint, format, build) is the
check: the build enforces most rules below and prints the fix.

Item actions use a hoverable, clickable row, right-click menu and a "⋯" entrance revealed on
hover or selection. Put secondary actions in that menu, mark destructive items and report
results. Reuse the app's row/menu/toast primitives even for session-local items; mount their
layers if absent. Before finishing, exercise both menu entrances and readable content at
60×20. Keep waits animated while pending, with content positions fixed.

### Gotchas

- There is no DOM. Lay out with `<box>` (flex props on the element: `flexDirection`, `gap`,
  `padding`, `border`) and put every string inside `<text>`, styled with props (`fg`, `bg`) and
  `<strong>`/`<span>` children. There is no `className`, no CSS, no `div` and no `onClick`: a
  pointer handler is `onMouseDown`.
- Bind keys with `useBindings` from `@luciole-sh/core/client`, in a Client Component: a
  binding lives as long as its component. `Ctrl+C` quits the app.
- Keep `page.tsx` a Server Component: `async`, reading data directly, with no hooks, state,
  effects or context. Put interaction in a `"use client"` component the page renders, and
  pass it data and Server Functions as props. Everything passed as a prop reaches the Client.
- Layouts, loading, error and not-found files are always Client Components: start them with
  `"use client"` and a default export. A layout gets data from a Server Function it calls and
  re-reads it in `useInvalidation`; a Server layout does not exist.
- Navigate with `useNavigate()` from `@luciole-sh/core/client`:
  `navigate({ to: "/notes/$id", params: { id } })`. There is no `<Link>` and no
  `next/navigation`.
- Params and search params are strings: parse them with Zod. Use `[id]`, `[...rest]` and
  `(group)`; `[[...x]]` does not exist.
- `app/routeTree.gen.ts` is written by the build: commit it, never edit it.
- A `"use server"` module exports only named `export async function` declarations, plus
  `export const auth = "public"` when it is public. Validate every argument with Zod: types
  are not checked at runtime. Pages and Server Functions require a sign-in session unless
  they export that `auth`.
- Nothing refreshes after a Server Function by itself: call `invalidate()` or
  `invalidate({ tag })` from `@luciole-sh/core/server` after every change.
- A `"use cache"` read tags itself with `cacheTag(...)` and takes the user as an argument:
  `getSession()` throws inside it, so call it in the page or the Server Function.
- Keep a module on one side with `server/` or `import "server-only"`, and
  `import "client-only"` for code that must run on the user's machine ($EDITOR, clipboard).
- Import with relative paths or `#subpath` imports: tsconfig path aliases, `require()` and
  dynamic `import()` fail the build.
- Client and Server must come from the same build: a `409` means one of them is stale, so
  rebuild and restart both.
- Command-line options belong in `app/args.ts` (`defineArgs`), never in `process.argv`.

### Docs

Under `node_modules/@luciole-sh/core/docs/`, read the page before you touch its area:

- `getting-started.md`: run, create or change an app
- `concepts/client-and-server.md`: which side runs a file, what crosses, the build ID
- `guides/anatomy-of-an-app.md`: the starter's files and the path of a save
- `concepts/routing.md`: routes, params, groups, layouts, navigation, search params
- `concepts/server-components.md`: what a page may do and pass
- `concepts/client-components.md`: `"use client"`, keys, side markers, packages
- `concepts/server-functions.md`: `"use server"`, failures, `invalidate`, `useLive`
- `concepts/loading-and-errors.md`: loading, error and not-found screens, connection status
- `concepts/session-restore.md`: fields, focus and scroll that survive a restart
- `concepts/cache.md`: `"use cache"`, tags, `staleTime`
- `concepts/authentication.md`: `server/auth.ts`, public pages, tokens
- `guides/latency-and-faults.md`: test under a slow or failing network
- `guides/devtools.md`: inspect a running app
- `guides/opening-an-app.md`: run locally, over SSH, by URL
- `guides/ship-a-binary.md`: compile one executable
- `guides/host-a-server.md`: run the Server on another machine
- `guides/untrusted-apps.md`: sandbox and capabilities
- `guides/terminals-and-panes.md`: `<Terminal>` and `<Embed>`
- `guides/testing.md`: test an app
- `guides/coding-agents.md`: these skills and this block
- `reference/cli.md`: a `luciole` subcommand or flag
- `reference/app-arguments.md`: command-line options (`app/args.ts`)
- `reference/package-json.md`: the `luciole` field, `luciole.json`
- `reference/environment.md`: an environment variable
- `reference/api.md`: an export of `@luciole-sh/core`
- `reference/build-and-distribution.md`: build output, publishing
- `reference/upstream-libraries.md`: OpenTUI, TanStack Router and optional Form boundaries
- `reference/optional-packages.md`: grammars, math, web target
- `reference/troubleshooting.md`: an error message
- `reference/releases.md`: versions and upgrades
- `reference/glossary.md`: a term

### Skills

Use `luciole-app` to build a feature (route, page, Server Function, cache, auth),
`luciole-tui` for terminal UI and keys, `luciole-test` for tests, `luciole-debug` when something
fails; `luciole-ship` and `luciole-upgrade` run only when the user asks to ship or upgrade.

Before composing a screen, read `luciole-tui/references/opentui.md`. Before navigation,
active tabs, search, preload, history or pending UI, read `luciole-app/references/routing.md`;
for optional form libraries, read `luciole-app/references/session-restore.md`.
For clickable items, menus, hover, images or a wait, read
`luciole-tui/references/interaction.md`.
