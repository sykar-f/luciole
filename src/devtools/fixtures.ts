import { message, PLUGIN, PROTOCOL_VERSION, type PluginId } from "./protocol";
import { parseEvent } from "./schema";
import type { Stored } from "./model/session";

/**
 * A simulated session of the Notes example, for tests and `airtty devtools --demo`. It
 * stands in for what feat/use-cache will emit (Server `cache` events, the Client's
 * `router-cache` loaders) and exercises every flag: a sequential waterfall, a double
 * invalidation, a stale cache read, a failure and a live stream still open.
 */
const CLIENT = 1,
  SERVER = 2;
export const FIXTURE_START = 1_750_000_000_000;

export function fixtureSession(t0 = FIXTURE_START): Stored[] {
  const out: Stored[] = [];
  const push = (source: number, plugin: PluginId, suffix: string, payload: unknown) => {
    const event = parseEvent(message(plugin, suffix, payload));
    if (!event) throw new Error(`Invalid fixture event ${plugin}:${suffix}`);
    out.push({ seq: out.length + 1, source, event });
  };
  let id = 0;
  const client = (
    type: string,
    at: number,
    callId: string,
    kind: string,
    target: string,
    rest = {},
  ) =>
    push(CLIENT, PLUGIN.client, type, {
      type,
      id: ++id,
      callId,
      at: t0 + at,
      kind,
      target,
      ...rest,
    });
  const server = (
    type: string,
    at: number,
    callId: string,
    kind: string,
    target: string,
    rest = {},
  ) => push(SERVER, PLUGIN.server, type, { type, callId, at: t0 + at, kind, target, ...rest });
  const cache = (
    at: number,
    callId: string | undefined,
    op: string,
    key: string,
    fn: string,
    tags: string[],
    ms?: number,
  ) =>
    push(SERVER, PLUGIN.server, "cache", {
      type: "cache",
      op,
      key,
      fn,
      tags,
      callId,
      ms,
      at: t0 + at,
    });
  const loader = (
    at: number,
    phase: string,
    routeId: string,
    href: string,
    cause: string,
    rest = {},
  ) =>
    push(CLIENT, PLUGIN.client, "loader", {
      type: "loader",
      at: t0 + at,
      phase,
      routeId,
      href,
      cause,
      ...rest,
    });
  /** A whole request: Client and Server sides, a few chunks. */
  const request = (
    callId: string,
    kind: "render" | "action",
    target: string,
    cause: string,
    at: number,
    {
      server: work = 5,
      bytes = [1200, 800],
      gap = 2,
    }: { server?: number; bytes?: number[]; gap?: number } = {},
  ) => {
    client("request", at, callId, kind, target, { cause });
    server("request", at + gap, callId, kind, target);
    server("response", at + gap + work, callId, kind, target, { status: 200, ms: work });
    client("response", at + 2 * gap + work, callId, kind, target, {
      status: 200,
      ms: 2 * gap + work,
    });
    let t = at + 2 * gap + work;
    for (const size of bytes) {
      t += 8;
      client("chunk", t, callId, kind, target, { bytes: size });
    }
    const total = bytes.reduce((a, b) => a + b, 0);
    server("end", t - 1, callId, kind, target, {
      ms: t - 1 - at - gap,
      bytes: total,
      cancelled: false,
    });
    client("end", t + 1, callId, kind, target, { ms: t + 1 - at, bytes: total, cancelled: false });
    return t + 1;
  };

  push(CLIENT, PLUGIN.bus, "hello", {
    protocol: PROTOCOL_VERSION,
    role: "client",
    pid: 4101,
    app: "notes",
    components: true,
  });
  push(SERVER, PLUGIN.bus, "hello", {
    protocol: PROTOCOL_VERSION,
    role: "server",
    pid: 4100,
    app: "notes",
    buildId: "b-demo",
  });

  // 1. First page: a cache miss, then a write.
  loader(0, "start", "/", "/", "navigation");
  cache(5, "c1", "miss", "listNotes()", "server/notes#listNotes", ["notes"]);
  cache(38, "c1", "write", "listNotes()", "server/notes#listNotes", ["notes"], 33);
  const first = request("c1", "render", "/", "navigation", 2, { server: 40 });
  loader(first + 1, "end", "/", "/", "navigation", { ms: first + 1, result: "ok" });
  push(CLIENT, PLUGIN.client, "navigation", { type: "navigation", at: t0 + first + 2, path: "/" });

  // 2. A note, from the Server cache; then its comments, fetched only once it rendered.
  loader(1000, "start", "/notes/[id]", "/notes/1", "navigation");
  cache(1004, "c2", "hit", "getNote(1)", "server/notes#getNote", ["notes", "note:1"], 1);
  push(SERVER, PLUGIN.console, "entry", {
    at: t0 + 1005,
    level: "log",
    text: "loading note 1",
    callId: "c2",
  });
  const note = request("c2", "render", "/notes/[id]", "navigation", 1001, { server: 6 });
  loader(note + 1, "end", "/notes/[id]", "/notes/1", "navigation", {
    ms: note - 999,
    result: "ok",
  });
  request("c3", "action", "actions/notes#getComments", "action", note + 6, {
    server: 18,
    bytes: [300],
  });

  // 3. Back and forth: TanStack's cache answers, no request ("(memory cache)").
  loader(2000, "end", "/", "/", "navigation", {
    ms: 0,
    result: "ok",
    source: "router-cache",
    synthetic: true,
  });
  loader(2500, "end", "/notes/[id]", "/notes/1", "navigation", {
    ms: 0,
    result: "ok",
    source: "router-cache",
    synthetic: true,
  });

  // 4. Save: the Server invalidates, and the component invalidates again: two renders.
  const saved = request("c4", "action", "actions/notes#saveNote", "action", 3000, {
    server: 12,
    bytes: [120],
  });
  cache(3010, "c4", "invalidate", "getNote(1)", "server/notes#getNote", ["note:1"]);
  push(CLIENT, PLUGIN.client, "invalidate", {
    type: "invalidate",
    at: t0 + saved + 1,
    paths: ["/notes"],
    origin: "server",
  });
  loader(saved + 1, "start", "/notes/[id]", "/notes/1", "invalidation");
  client("request", saved + 2, "c5", "render", "/notes/[id]", { cause: "invalidation" });
  server("request", saved + 4, "c5", "render", "/notes/[id]");
  push(CLIENT, PLUGIN.client, "invalidate", {
    type: "invalidate",
    at: t0 + saved + 5,
    paths: ["/notes/1"],
    origin: "client",
  });
  client("end", saved + 6, "c5", "render", "/notes/[id]", { ms: 4, bytes: 0, cancelled: true });
  server("end", saved + 7, "c5", "render", "/notes/[id]", { ms: 3, bytes: 0, cancelled: true });
  loader(saved + 6, "end", "/notes/[id]", "/notes/1", "invalidation", { ms: 5, result: "aborted" });
  loader(saved + 6, "start", "/notes/[id]", "/notes/1", "invalidation");
  cache(saved + 10, "c6", "stale", "getNote(1)", "server/notes#getNote", ["notes", "note:1"], 2);
  const again = request("c6", "render", "/notes/[id]", "invalidation", saved + 7, { server: 9 });
  loader(again + 1, "end", "/notes/[id]", "/notes/1", "invalidation", {
    ms: again - saved - 5,
    result: "ok",
  });
  push(CLIENT, PLUGIN.console, "entry", {
    at: t0 + again + 3,
    level: "warn",
    text: "NoteEditor: draft kept after refresh",
  });

  // 5. A failing action, and a live stream still open.
  client("request", 4000, "c7", "action", "actions/notes#deleteNote", { cause: "action" });
  server("request", 4002, "c7", "action", "actions/notes#deleteNote");
  push(SERVER, PLUGIN.console, "entry", {
    at: t0 + 4010,
    level: "error",
    text: "Error: note 1 is locked",
    callId: "c7",
  });
  server("error", 4011, "c7", "action", "actions/notes#deleteNote", {
    ms: 9,
    message: "note 1 is locked",
  });
  client("error", 4014, "c7", "action", "actions/notes#deleteNote", {
    ms: 14,
    outcome: "unknown",
    message: "HTTP 500: Server request failed",
  });
  client("request", 4500, "c8", "action", "actions/presence#watch", { cause: "live" });
  server("request", 4502, "c8", "action", "actions/presence#watch");
  server("response", 4504, "c8", "action", "actions/presence#watch", { status: 200, ms: 2 });
  client("response", 4506, "c8", "action", "actions/presence#watch", { status: 200, ms: 6 });
  for (let t = 4600; t <= 5400; t += 200)
    client("chunk", t, "c8", "action", "actions/presence#watch", { bytes: 64 });

  push(CLIENT, PLUGIN.router, "state", {
    at: t0 + again + 2,
    status: "idle",
    href: "/notes/1",
    resolvedHref: "/notes/1",
    matches: [
      {
        id: "__root__",
        routeId: "__root__",
        pathname: "/",
        status: "success",
        isFetching: false,
        updatedAt: t0,
      },
      {
        id: "/notes",
        routeId: "/notes",
        pathname: "/notes",
        status: "success",
        isFetching: false,
        updatedAt: t0 + 1000,
      },
      {
        id: "/notes/$id/notes/1",
        routeId: "/notes/$id",
        pathname: "/notes/1",
        status: "success",
        isFetching: false,
        invalid: false,
        updatedAt: t0 + again,
        params: { id: '"1"' },
        search: {},
        loaderData: "<NotePage />",
      },
    ],
    cached: [
      {
        id: "//",
        routeId: "/",
        pathname: "/",
        status: "success",
        isFetching: false,
        updatedAt: t0 + first,
        loaderData: "<NoteList />",
      },
    ],
  });
  const node = (
    id: number,
    parent: number | null,
    depth: number,
    name: string,
    kind: string,
    rest = {},
  ) => ({
    id,
    parent,
    depth,
    name,
    kind,
    renders: 1,
    ...rest,
  });
  push(CLIENT, PLUGIN.components, "commit", {
    at: t0 + again + 4,
    flashed: [4, 6],
    nodes: [
      node(1, null, 0, "Layout", "client", {
        reason: "mount",
        props: { children: "<Outlet />" },
        hooks: ['state: "Connected"'],
        rect: { x: 0, y: 0, width: 80, height: 24 },
      }),
      node(2, 1, 1, "NotesLayout", "client", {
        reason: "mount",
        rect: { x: 0, y: 1, width: 80, height: 22 },
      }),
      node(3, 2, 2, "NotePage", "server", { env: "Server", renders: 0 }),
      node(4, 3, 3, "NoteEditor", "client", {
        renders: 3,
        renderedAt: t0 + again,
        reason: "props: note",
        props: { note: '{ id: 1, title: "Groceries" }', save: "ƒ saveNote()" },
        hooks: ['state: "Groceries"', "effect", "ref"],
        rect: { x: 2, y: 3, width: 76, height: 16 },
      }),
      node(5, 4, 4, "Input", "client", {
        renders: 3,
        reason: "props: value",
        rect: { x: 2, y: 4, width: 76, height: 1 },
      }),
      node(6, 1, 1, "KeyHelp", "client", {
        renders: 5,
        renderedAt: t0 + again,
        reason: "parent",
        unnecessary: true,
        rect: { x: 0, y: 23, width: 80, height: 1 },
      }),
    ],
  });
  for (const [at, name] of [
    [900, "down"],
    [990, "return"],
    [2990, "s"],
  ] as const)
    push(CLIENT, PLUGIN.input, "key", {
      at: t0 + at,
      name,
      sequence: name,
      ctrl: name === "s",
      meta: false,
      shift: false,
    });
  return out;
}
