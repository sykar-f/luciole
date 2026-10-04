// The terms the docs define, one entry each, which reference/glossary.mdx lists.

export interface Term {
  /** The name the glossary lists, as the prose writes it. */
  name: string;
  /**
   * What counts as an occurrence, as whole words. A form in lowercase also matches with a
   * capital, at the start of a sentence.
   */
  forms: readonly string[];
  /** Phrases in which a form means something else: an occurrence inside one stays plain. */
  not?: readonly string[];
  /** One or two sentences. Code goes between backticks, as in Markdown. */
  definition: string;
  /** The page that explains the term: its id in nav.ts, and a section's anchor if any. */
  page: string;
  /** The title of that page or section, the text of the glossary's link to it. */
  see: string;
}

/** The glossary's own page, by its id in nav.ts. */
export const glossaryPage = "reference/glossary";

export const glossary: readonly Term[] = [
  {
    name: "app list",
    forms: ["app list"],
    definition:
      "What `luciole` opens when you give it no target: your installed apps, and a search of the registry to install more.",
    page: "guides/opening-an-app",
    see: "Opening an app",
  },
  {
    name: "boundary",
    forms: ["boundary"],
    definition:
      'The line between the modules the Server runs and those the Client runs. `"use client"` draws it: a Server module that imports one receives a reference, not its code.',
    page: "concepts/client-components#where-does-the-boundary-fall",
    see: "Where does the boundary fall?",
  },
  {
    name: "build ID",
    forms: ["build ID", "build IDs"],
    definition:
      "A hash of everything a build reads. The Client sends it with every request, and a Server of another build refuses the request with a `409`.",
    page: "concepts/client-and-server#why-both-sides-come-from-one-build",
    see: "Why both sides come from one build",
  },
  {
    name: "cache tag",
    forms: ["cache tag", "cache tags", "tag", "tags"],
    not: ["git tag", "that tag", "no tag", "tag with a suffix", "and the tag"],
    definition:
      "A label that `cacheTag` puts on a cached result. Invalidating the tag purges that result, and the Client reloads the routes whose page read it.",
    page: "concepts/cache#label-and-age-a-result-with-cachetag-and-cachelife",
    see: "Label and age a result with cacheTag and cacheLife",
  },
  {
    name: "capability",
    forms: ["capability", "capabilities"],
    definition:
      "A right an app declares in `luciole.capabilities` of its `package.json`, such as reading a path or writing the clipboard. Only the `sandbox` mode enforces it.",
    page: "guides/untrusted-apps#declare-and-grant-capabilities",
    see: "Declare and grant capabilities",
  },
  {
    name: "Client",
    forms: ["Client", "Clients"],
    definition:
      "The program that runs in the user's terminal. It draws the app and handles every key and scroll, and it calls the Server only to load a page or run a Server Function.",
    page: "concepts/client-and-server",
    see: "Client and Server",
  },
  {
    name: "Client Component",
    forms: ["Client Component", "Client Components"],
    definition:
      'A component from a module that starts with `"use client"`, as every layout is. The Client runs it, so it handles keys, focus and local state.',
    page: "concepts/client-components",
    see: "Client Components",
  },
  {
    name: "Flight",
    forms: ["Flight", "React Flight"],
    definition:
      "React's serialization of a rendered tree, the form in which the Server answers the Client. It carries elements, props, promises and references, never the code of a component or a function.",
    page: "concepts/client-and-server#what-travels-between-the-client-and-the-server",
    see: "What travels between the Client and the Server",
  },
  {
    name: "generic Client",
    forms: ["generic Client"],
    definition:
      "The Client that `luciole` runs when you open a Server URL. It checks the publisher's signature, fetches the app's bundle and runs it in the mode you chose for that origin.",
    page: "guides/untrusted-apps#open-an-app-by-url",
    see: "Open an app by URL",
  },
  {
    name: "grace period",
    forms: ["grace period"],
    definition:
      "How long a Server that `luciole` started stays up after its last Client exits, 15 minutes by default. A Client that comes back in time finds the same Server.",
    page: "guides/opening-an-app#open-an-app-on-this-machine",
    see: "Open an app on this machine",
  },
  {
    name: "history entry",
    forms: ["history entry", "history entries"],
    definition:
      "One visit to a page in the Client's history, as in a browser. The restored session keeps the text of named fields, the focus and the scroll positions per history entry.",
    page: "concepts/session-restore",
    see: "Session restore",
  },
  {
    name: "host",
    forms: ["host", "hosts"],
    not: [
      "host unreachable",
      "host and port",
      "host or port",
      "hosts the app may reach",
      "by host",
      "net hosts",
      "host key",
      "ssh host",
      "the host you give",
      "static host",
    ],
    definition:
      "A program that runs an app inside itself, such as `luciole dev`, the generic Client or `examples/mux`. In the `sandbox` mode, the host checks the capabilities that the OS cannot.",
    page: "guides/untrusted-apps#who-enforces-what",
    see: "Who enforces what",
  },
  {
    name: "invalidation",
    forms: [
      "invalidation",
      "invalidations",
      "invalidate",
      "invalidates",
      "invalidated",
      "invalidating",
    ],
    definition:
      "What `invalidate()` declares after a change: a path or a cache tag whose data is out of date. The Client then reloads the routes concerned.",
    page: "concepts/server-functions#declare-what-a-server-function-changed",
    see: "Declare what a Server Function changed",
  },
  {
    name: "launcher",
    forms: ["launcher"],
    not: ["editor launcher", "native launcher", "to the launcher"],
    definition:
      "The part of `luciole` that opens a target. It builds a directory, installs a package, fetches a git source or reaches a Server URL, then starts the Client, and the Server when needed.",
    page: "guides/opening-an-app",
    see: "Opening an app",
  },
  {
    name: "layout",
    forms: ["layout", "layouts"],
    not: ["same layout", "first layout", "after layout", "layout does not move"],
    definition:
      "A `layout.tsx`: a Client Component that wraps every page below its directory. It stays mounted between them, so its state, focus and scroll survive a navigation.",
    page: "concepts/routing#keep-state-across-pages-with-a-layout",
    see: "Keep state across pages with a layout",
  },
  {
    name: "loader",
    forms: ["loader", "loaders"],
    definition:
      "The function TanStack Router runs to load a route. luciole's loader asks the Server to render the route's page, and resolves with its Flight tree.",
    page: "concepts/routing#navigate-from-a-client-component",
    see: "Navigate from a Client Component",
  },
  {
    name: "named field",
    forms: ["named field", "named fields"],
    definition:
      "A field given a `name`, such as `<Input name>`. The restored session keeps its text, and a field without a name is never written.",
    page: "concepts/session-restore#name-a-field-to-keep-its-text",
    see: "Name a field to keep its text",
  },
  {
    name: "origin",
    forms: ["origin", "origins"],
    definition:
      "The source that trust is granted to: a URL's scheme, host and port, as for a browser, or an installed package or a local command. The generic Client keeps the pinned key, the mode and the granted capabilities per origin.",
    page: "guides/untrusted-apps",
    see: "Apps you did not write",
  },
  {
    name: "outcome",
    forms: ["outcome", "outcomes"],
    definition:
      "What a failed request may have done on the Server, in the `outcome` of its `TransportError`: `not-sent`, `rejected` or `unknown`.",
    page: "concepts/server-functions#when-a-call-fails",
    see: "When a call fails",
  },
  {
    name: "PTY",
    forms: ["PTY", "PTYs", "pseudo-terminal", "pseudo-terminals"],
    definition:
      "A pseudo-terminal: the device a terminal program reads its keys from and draws on. `<Terminal>` runs a program on one.",
    page: "guides/terminals-and-panes",
    see: "Terminals and panes",
  },
  {
    name: "remote machine",
    forms: ["remote machine", "remote machines"],
    definition:
      "The machine that `--on` reaches over SSH to start an app's Server there, while the Client runs on yours.",
    page: "guides/opening-an-app#start-the-server-on-another-machine",
    see: "Start the Server on another machine",
  },
  {
    name: "restored session",
    forms: ["restored session", "restored sessions"],
    definition:
      "What the Client keeps across restarts, as a browser does: the history and, per history entry, the text of named fields, the focus and the scroll positions.",
    page: "concepts/session-restore",
    see: "Session restore",
  },
  {
    name: "route",
    forms: ["route", "routes"],
    definition:
      "A URL of the app, made from a `page.tsx` under `app/` and the directories above it. On each navigation, TanStack Router matches a route, its params and its layouts.",
    page: "concepts/routing",
    see: "Routing",
  },
  {
    name: "sandbox",
    forms: ["sandbox", "OS sandbox"],
    definition:
      "The mode that runs an app's Client in a child process under the OS sandbox: Seatbelt on macOS, `luciole-sandbox` on Linux. It is the only mode that enforces capabilities.",
    page: "guides/untrusted-apps#choose-a-mode",
    see: "Choose a mode",
  },
  {
    name: "Server",
    forms: ["Server", "Servers"],
    definition:
      "The program that renders pages, runs Server Functions and keeps the data. The Client reaches it over HTTP, a Unix socket or an SSH tunnel.",
    page: "concepts/client-and-server",
    see: "Client and Server",
  },
  {
    name: "Server Component",
    forms: ["Server Component", "Server Components"],
    definition:
      "A component the Server renders, as every `page.tsx` is by default. It reads data directly, and the Client receives what it rendered, never its code.",
    page: "concepts/server-components",
    see: "Server Components",
  },
  {
    name: "Server Function",
    forms: ["Server Function", "Server Functions"],
    definition:
      'An async function exported from a `"use server"` module. The Client calls it like any function: the call sends `POST /action`, and the function runs on the Server.',
    page: "concepts/server-functions",
    see: "Server Functions",
  },
  {
    name: "sign-in session",
    forms: ["sign-in session", "sign-in sessions"],
    definition:
      "Who signed in, as `authenticate` in `server/auth.ts` returns it for a request. Pages and Server Functions read it with `getSession()`.",
    page: "concepts/authentication",
    see: "Authentication",
  },
  {
    name: "token",
    forms: ["token", "tokens", "bearer token"],
    not: ["registry, with a token"],
    definition:
      "The bearer token, the string the Client sends with each request to prove who signed in. Your app sets it with `setToken`, or both sides read `LUCIOLE_TOKEN`.",
    page: "concepts/authentication#use-one-local-user-without-serverauthts",
    see: "Use one local user without server/auth.ts",
  },
];

/** A term's anchor on the glossary page: its name, lowercase, spaces as hyphens. */
export const anchorOf = (term: Term) => term.name.toLowerCase().replaceAll(" ", "-");

/** The glossary's entry for a term. */
export const glossaryHref = (term: Term) => `/docs/${glossaryPage}/#${anchorOf(term)}`;

/** The page that explains a term. */
export function pageHref(term: Term) {
  const [id, anchor] = term.page.split("#");
  return `/docs/${id}/${anchor ? `#${anchor}` : ""}`;
}

/** The terms in the glossary's order: alphabetical, whatever the case. */
export const alphabetical = [...glossary].sort((a, b) =>
  a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
);

/** A definition cut at its backticks: the odd parts are code. */
export const partsOf = (definition: string) =>
  definition.split("`").map((text, index) => ({ text, code: index % 2 === 1 }));

