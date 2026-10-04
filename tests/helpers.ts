import { afterAll, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { act, type ReactNode } from "react";
import type { Renderable } from "@opentui/core";
import type { MouseButton } from "@opentui/core/testing";
import type { testRender } from "@opentui/react/test-utils";
import { z } from "zod";
import { build, type BuildOptions } from "../packages/core/src/build";
import type { Application, ApplicationOptions, TransportEvent } from "../packages/core/src/client";
import { messageOf } from "../packages/core/src/guards";
import { readJsonFile } from "../packages/core/src/package-json";
import type { DraftStore } from "../examples/notes/components/draft";

/**
 * The budget of a test that builds an application, or several, and starts its Server:
 * 3 to 15 s on this suite under a loaded machine (several sessions on one Mac, swapping),
 * where the default 20 s left no room for a stall of the machine itself.
 */
export const BUILD_TEST_MS = 60_000;

/**
 * How long a wait for an event lasts before it gives up: the guard against a hang, which
 * says nothing of how fast the event should come. Under a loaded host a build, a request or
 * a timer of the product lands late; a wait bounded by what it takes on an idle machine
 * then fails on the machine, not on the code. Half of `BUILD_TEST_MS`.
 */
export const WAIT_MS = BUILD_TEST_MS / 2;

/** `value`, which the test expects to exist: fails naming `what` when the domain has none. */
export function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Expected ${what}`);
  return value;
}

/**
 * A fresh application directory under tmpdir, named after `prefix`, with the checkout's
 * node_modules linked in: `@luciole-sh/core`, React and its packages resolve as in an example,
 * and a run killed midway leaves nothing in the checkout (format and lint read it).
 */
export async function temporaryApp(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), `luciole-${prefix}-`));
  await symlink(resolve("node_modules"), join(directory, "node_modules"), "dir");
  return directory;
}

/**
 * An example of the checkout (`examples/notes`…) built for this test file alone, while
 * the file loads: before its tests and hooks, outside every timeout. The output is a
 * temporary application directory's `.luciole`, beside a node_modules link where the
 * bundles' external packages resolve; its Server runs from `output`, its Client imports
 * from `directory` (`importClient`). Built in place, `examples/<name>/.luciole` was one
 * output for every file of a parallel run: a test's time included waiting on its lock for
 * another file's build, and a signed or bundled rebuild replaced the directory another
 * file's Server was running from. Called at a test file's top level; removed after it.
 */
export async function privateBuild(example: string, options?: BuildOptions) {
  const directory = await temporaryApp(`build-${basename(example)}`);
  afterAll(() => rm(directory, { recursive: true, force: true }));
  const { buildId, output } = await build(resolve(example), join(directory, ".luciole"), options);
  return { directory, output, buildId };
}
export type PrivateBuild = Awaited<ReturnType<typeof privateBuild>>;

/** The directory holding a `package.json` or a `.git` that is `directory` or above it, if any. */
function projectAbove(directory: string): string | undefined {
  for (let at = directory; ; at = dirname(at)) {
    if (existsSync(join(at, "package.json")) || existsSync(join(at, ".git"))) return at;
    if (dirname(at) === at) return undefined;
  }
}

/**
 * A fresh directory with no project above it: no `package.json` nor `.git` in it or in any
 * ancestor, so `bun add` installs where it runs and nothing resolves to a checkout. `tmpdir()`
 * is not that when TMPDIR points into a checkout (the sweep's does), hence the fallback to
 * `/tmp`; with no such place the call fails rather than let a test pass on a false premise.
 */
export async function isolatedTemporary(prefix: string) {
  for (const candidate of [tmpdir(), "/tmp"]) {
    const root = await realpath(candidate).catch(() => undefined);
    if (root !== undefined && projectAbove(root) === undefined) return mkdtemp(join(root, prefix));
  }
  throw new Error(`No temporary directory free of a project above it (tmpdir: ${tmpdir()})`);
}

/**
 * Runs `command` to its end and gives what it wrote, through an asynchronous spawn.
 * Bun 1.4's spawnSync can lose its child's exit and spin forever at 100 % CPU, the child
 * a zombie (oven-sh/bun#34069); bun test's timeout cannot interrupt a blocked thread, so a
 * worker that hit it hung the whole run. Awaited, the exit comes through the event loop,
 * and a child that never ends fails by the test's timeout instead.
 */
export async function execute(
  command: readonly string[],
  options: { cwd?: string; env?: Record<string, string | undefined>; stdin?: Uint8Array } = {},
) {
  const child = Bun.spawn([...command], {
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).arrayBuffer(),
    child.exited,
  ]);
  return { pid: child.pid, exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

/** What `testRender` resolves with: the renderer, input mocks and frame captures. */
export type TestUI = Awaited<ReturnType<typeof testRender>>;
/** Destroys a test renderer inside `act()`, when the test got as far as rendering. */
export async function destroy(ui: TestUI | undefined) {
  if (ui) await act(async () => ui.renderer.destroy());
}
/** The renderable with this `id`, checked to be a `type` (an OpenTUI renderable class). */
export function renderable<T>(
  ui: TestUI,
  id: string,
  type: abstract new (...args: never[]) => T,
): T {
  const found = ui.renderer.root.findDescendantById(id);
  if (!(found instanceof type)) throw new Error(`#${id} is not a ${type.name}`);
  return found;
}

/**
 * A `@luciole-sh/markdown-editor` field by id, with its Markdown. The App's bundle carries its own
 * copy of the editor's class, so the renderable is recognized by its shape.
 */
export function markdownEditor(ui: TestUI, id: string) {
  const found = ui.renderer.root.findDescendantById(id);
  if (!found || typeof Reflect.get(found, "value") !== "string")
    throw new Error(`#${id} is not a Markdown editor`);
  return {
    node: found,
    get value(): string {
      return String(Reflect.get(found, "value"));
    },
  };
}

const STARTUP_TIMEOUT_MS = 10_000;
/** The line a Server prints once it listens (src/server.ts). */
const Ready = z.object({
  ready: z.literal(true),
  port: z.number().int(),
  pid: z.number().int(),
  buildId: z.string(),
});
export async function launch(file: string, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["--conditions=react-server", file], {
    env: { ...process.env, PORT: "0", LUCIOLE_TEST: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (s: Buffer) => (errors += s.toString()));
  const ready = await new Promise<z.infer<typeof Ready>>((yes, no) => {
    const timer = setTimeout(() => {
      child.kill();
      no(new Error("startup timeout " + errors));
    }, STARTUP_TIMEOUT_MS);
    child.on("exit", () => {
      clearTimeout(timer);
      no(new Error("server exited " + errors));
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return;
      }
      const parsed = Ready.safeParse(value);
      if (!parsed.success) return;
      clearTimeout(timer);
      yes(parsed.data);
    });
  });
  return {
    child,
    ...ready,
    url: `http://127.0.0.1:${ready.port}`,
    stop: () =>
      new Promise<void>((done) => {
        if (child.exitCode !== null || child.signalCode !== null) return done();
        child.once("exit", () => done());
        child.kill();
      }),
  };
}
/** `headline`, then the state when there is one; a state that throws says so after it. */
function described(headline: string, state?: () => string) {
  if (!state) return headline;
  try {
    return `${headline}. State:\n${state()}`;
  } catch (error: unknown) {
    return `${headline}. State unavailable: ${messageOf(error)}`;
  }
}
const timedOut = (state?: () => string) => described("Condition timed out", state);

/**
 * The waits of `until` and `eventually` still polling. bun's timeout for a test that sets
 * none (20 s in `bun run test`) ends it before `WAIT_MS` ends its wait, and reports it
 * without what the wait would have said. After each test, a wait still polling prints its
 * state under that test, then stops where it stands: the abandoned test runs no further.
 */
type Wait = { start: number; state?: () => string; ended: boolean };
const waiting = new Set<Wait>();
try {
  afterEach(() => {
    for (const wait of waiting) {
      wait.ended = true;
      const ms = Math.round(performance.now() - wait.start);
      console.error(
        described(`The test ended while a wait still polled, after ${ms} ms`, wait.state),
      );
    }
    waiting.clear();
  });
} catch {
  // Outside bun test (scripts/linux-client.ts imports `launch`): no test ends a wait.
}
function watched(state?: () => string): Wait {
  const wait = { start: performance.now(), state, ended: false };
  waiting.add(wait);
  return wait;
}
/** Never settles: what an abandoned test would run after its wait never runs. */
const abandoned = () => new Promise<never>(() => {});
/**
 * Polls `check` until it holds; a failure prints `state()`: what the process and its screen
 * showed. The guard against a hang is `WAIT_MS`, as for `untilFrame`; a test that bun's
 * timeout ends first still prints the state.
 */
export async function until(check: () => boolean, timeout = WAIT_MS, state?: () => string) {
  const wait = watched(state);
  try {
    while (!check()) {
      if (wait.ended) return abandoned();
      if (performance.now() - wait.start > timeout) throw new Error(timedOut(state));
      await Bun.sleep(10);
    }
  } finally {
    waiting.delete(wait);
  }
}
/**
 * `until` for a check that must ask: a socket, a file, another process. The guard against
 * a hang is `WAIT_MS`, as for `untilFrame`.
 */
export async function eventually(
  check: () => Promise<boolean>,
  timeout = WAIT_MS,
  state?: () => string,
) {
  const wait = watched(state);
  try {
    while (!(await check())) {
      if (wait.ended) return abandoned();
      if (performance.now() - wait.start > timeout) throw new Error(timedOut(state));
      await Bun.sleep(10);
    }
  } finally {
    waiting.delete(wait);
  }
}
/**
 * Waits for `child` to exit, as a test that told it to quit expects. One still running after
 * `timeout` (the guard against a hang, which says nothing of how fast it quits) is killed,
 * and the wait fails: a forced end is not the quit the test asked for.
 */
export async function exited(child: { exited: Promise<number>; kill(): void }, timeout = WAIT_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<"hung">((done) => (timer = setTimeout(() => done("hung"), timeout)));
  const outcome = await Promise.race([child.exited, hung]);
  clearTimeout(timer);
  if (outcome !== "hung") return outcome;
  child.kill();
  throw new Error(`The process did not exit within ${timeout} ms`);
}

/**
 * Renders `ui` until its frame shows `text`, and returns that frame. The guard against a
 * hang is `WAIT_MS`: how soon the frame gets there says nothing of the code, so a loaded
 * machine only makes the wait longer.
 */
export async function untilFrame(ui: TestUI, text: string, timeout = WAIT_MS) {
  const start = performance.now();
  for (;;) {
    await act(async () => {
      await ui.renderOnce();
    });
    const frame = ui.captureCharFrame();
    if (frame.includes(text)) return frame;
    if (performance.now() - start > timeout) throw new Error(timedOut(() => frame));
    await Bun.sleep(10);
  }
}

/** What `node` and its descendants are still answering: a Tree-sitter highlight, an image. */
function answering(node: Renderable): Promise<unknown>[] {
  const own = [
    Reflect.get(node, "isHighlighting") === true && Reflect.get(node, "highlightingDone"),
    Reflect.get(node, "loading") === true && Reflect.get(node, "loadPromise"),
  ].filter((promise): promise is Promise<unknown> => promise instanceof Promise);
  return [...own, ...node.getChildren().flatMap(answering)];
}

/**
 * Renders `ui` until it shows `text`, nothing in it is still answering (a code block's
 * highlight, an image's load) and one more frame draws the same, then returns that frame.
 * It waits on those answers, not on time; WAIT_MS only guards against a hang.
 */
export async function untilDrawn(ui: TestUI, text = "") {
  const deadline = performance.now() + WAIT_MS;
  let drawn: string | undefined;
  for (;;) {
    await act(async () => {
      await ui.renderOnce();
    });
    const pending = answering(ui.renderer.root);
    const frame = ui.captureCharFrame();
    if (!pending.length && frame === drawn) return frame;
    drawn = pending.length || !frame.includes(text) ? undefined : frame;
    const left = deadline - performance.now();
    if (left < 0) throw new Error(timedOut(() => frame));
    if (!pending.length) {
      // A turn of the event loop, not a delay: what is due (a timer, I/O) runs first.
      await act(() => new Promise<void>((done) => setImmediate(done)));
      continue;
    }
    // The hang guard, not a wait: it only ends the wait when an answer never comes.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hang = new Promise<void>((done) => (timer = setTimeout(done, left)));
    await act(() => Promise.race([Promise.allSettled(pending), hang]));
    clearTimeout(timer);
  }
}

/**
 * The requests `app` has on the wire, read from its transport events, and those that have
 * finished (`end` or `error`), in order. A teardown awaits `settled()` before it stops the
 * Server: a call left in flight, unawaited by the application or abandoned by a failed
 * assertion, would otherwise be cut into an unhandled TransportError.
 */
export function wire(app: Pick<Application, "onEvent">) {
  const open = new Set<number>();
  const finished: Extract<TransportEvent, { type: "end" | "error" }>[] = [];
  app.onEvent((event) => {
    if (event.type === "request") open.add(event.id);
    if (event.type !== "end" && event.type !== "error") return;
    open.delete(event.id);
    finished.push(event);
  });
  return { open, finished, settled: () => until(() => open.size === 0, WAIT_MS) };
}

/** What a generated Client's `createApp` takes: the build provides the rest. */
export type ClientOptions = Omit<ApplicationOptions, "routeTree" | "buildId" | "resolveModule">;
/**
 * The exports of a generated Client (`.luciole/client/index.js`, see src/build.ts). The
 * bundle is untyped JavaScript: its functions are checked to be there, their signatures
 * are the build's contract.
 */
export type BuiltClient = {
  createApp: (options: ClientOptions) => Application;
  Shell: (props: { app: Application }) => ReactNode;
};
const isBuiltClient = (value: unknown): value is BuiltClient =>
  typeof value === "object" &&
  value !== null &&
  "createApp" in value &&
  typeof value.createApp === "function" &&
  "Shell" in value &&
  typeof value.Shell === "function";
/**
 * Imports the generated Client of `directory`. A distinct `tag` gives a test its own
 * runtime (module registry, router, Drafts); the same tag shares it.
 */
export async function importClient(directory: string, tag?: string): Promise<BuiltClient> {
  const file = join(directory, ".luciole/client/index.js");
  const module: unknown = await import(tag ? `${file}?${tag}` : file);
  if (!isBuiltClient(module)) throw new Error(`${file} is not a generated Client`);
  return module;
}

const isDraftStore = (value: unknown): value is DraftStore =>
  typeof value === "object" &&
  value !== null &&
  "get" in value &&
  typeof value.get === "function" &&
  "capacity" in value &&
  typeof value.capacity === "number";
/**
 * The Draft store of a generated Client (`components/draft.ts`): application state,
 * reached through the build's Client Reference registry like any "use client" module.
 * Notes and Forge share its code; the bundle's class is not the one tests import.
 */
export function draftsOf(app: Application) {
  const { buildId, resolveModule } = app.options;
  const { drafts } = resolveModule(`${buildId}/components/draft.ts`);
  if (!isDraftStore(drafts)) throw new Error("components/draft.ts exports no Draft store");
  return drafts;
}

/** The Draft an editor already opened for note `id`; fails rather than open one. */
export function draftOf(app: Application, id: string) {
  const store = draftsOf(app);
  const opened = store.size;
  // `get` opens a Draft from a Note when none exists: the size tells whether it did.
  const draft = store.get({ id, title: "", value: "", version: 0, updated: 0 });
  if (store.size !== opened) throw new Error(`No Draft is open for note ${id}`);
  return draft;
}

const ClientReference = z.object({ id: z.string(), chunks: z.array(z.string()), name: z.string() });
/** `.luciole/manifest.json`, as src/build.ts writes it. */
const Manifest = z.object({
  buildId: z.string(),
  manifest: z.record(z.string(), ClientReference),
  routes: z.array(
    z.object({
      id: z.string(),
      url: z.string(),
      auth: z.enum(["public", "required"]),
      page: z.string(),
      layouts: z.array(z.string()),
      loading: z.string().nullable(),
      error: z.string().nullable(),
      notFound: z.string().nullable(),
    }),
  ),
  clientPackages: z.array(z.object({ name: z.string(), version: z.string() })),
  serverGraph: z.array(z.string()),
  clientGraph: z.array(z.string()),
});
export const readManifest = (directory: string) =>
  readJsonFile(join(directory, ".luciole/manifest.json"), Manifest);

/** Server counters, exposed in test mode only (`/test-metrics`). */
export const Metrics = z.object({ renders: z.number(), actions: z.number() });
export async function metricsOf(
  server: { url: string; buildId: string },
  headers: Record<string, string> = {},
) {
  const response = await fetch(server.url + "/test-metrics", {
    headers: { "x-luciole-build": server.buildId, ...headers },
  });
  return Metrics.parse(await response.json());
}

/**
 * What `promise` rejects with; throws when it resolves. bun-types declares
 * `expect(promise).rejects.toThrow()` as `void` although it must be awaited: assert on
 * this value instead (`toBeInstanceOf`, and `toContain`/`toMatch` on `messageOf`).
 */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("Expected a rejection, the promise resolved");
}

/**
 * Writes the session a crashed Client would have left (src/session.ts) under `key`: on
 * the second of two history entries, owned by a process that no longer exists.
 */
export async function leaveCrashedSession(state: string, name: string, key: string, href: string) {
  const dead = (await execute(["true"])).pid;
  await Bun.write(
    join(state, "luciole", name, "sessions", `${crypto.randomUUID()}.json`),
    JSON.stringify({
      version: 1,
      server: key,
      pid: dead,
      updatedAt: Date.now(),
      index: 1,
      entries: [
        { href: "/", fields: {} },
        { href, fields: {} },
      ],
    }),
  );
}

/**
 * A `/render` body as src/cache/render.ts shapes it: `{ tree, tags }`, the page being a
 * Flight stream of its own (row 1: open, one binary chunk, close) and `tags` row 2.
 */
export function renderBody(page: string, tags: string[] = []) {
  const bytes = new TextEncoder().encode(page).byteLength.toString(16);
  return `1:R\n0:{"tree":"$1","tags":"$@2"}\n1:o${bytes},${page}1:C\n2:${JSON.stringify(tags)}\n`;
}

/** Where `text` is drawn: its first cell, or undefined when the frame does not show it. */
export function cellOf(ui: TestUI, text: string) {
  const rows = ui.captureCharFrame().split("\n");
  const y = rows.findIndex((row) => row.includes(text));
  return y < 0 ? undefined : { x: rows[y]?.indexOf(text) ?? 0, y };
}
/** A left click on the first cell of `text`, as a user points at a label; fails if not shown. */
export async function clickOn(ui: TestUI, text: string, button?: MouseButton) {
  await ui.renderOnce();
  const cell = cellOf(ui, text);
  if (!cell) throw new Error(`Nothing to click: "${text}" is not shown\n${ui.captureCharFrame()}`);
  await ui.mockMouse.click(cell.x, cell.y, button);
}
