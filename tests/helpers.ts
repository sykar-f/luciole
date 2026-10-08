import { existsSync } from "node:fs";
import { mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { BuildOptions } from "../packages/core/src/build";
import type { Application } from "../packages/core/src/client";
import { readJsonFile } from "../packages/core/src/package-json";
import { buildApp } from "../packages/core/src/test/build";
import {
  cellOf,
  clickOn,
  destroy,
  importClient,
  wire,
  type BuiltClient,
  type ClientOptions,
} from "../packages/core/src/test/client";
import { launchServer } from "../packages/core/src/test/server";
import {
  eventually,
  TEST_TIMEOUT_MS,
  until,
  untilDrawn,
  untilFrame,
  WAIT_MS,
  type TestUI,
} from "../packages/core/src/test/wait";
import type { DraftStore } from "../examples/notes/components/draft";

/**
 * The budget of a test that builds an application, or several, and starts its Server:
 * 3 to 15 s on this suite under a loaded machine (several sessions on one Mac, swapping),
 * where the default 20 s left no room for a stall of the machine itself.
 */
export const BUILD_TEST_MS = TEST_TIMEOUT_MS;
export { WAIT_MS };

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
export const privateBuild = (example: string, options?: BuildOptions) => buildApp(example, options);
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

export type { TestUI };
export { destroy };
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

/** Starts the Server bundle at `file` on a free port; see `startServer` for an app's own. */
export const launch = launchServer;
export { until, eventually, untilFrame, untilDrawn };

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
 * The command line that runs `command` in a terminal of its own, script(1) writing its
 * screen to `log`. macOS and util-linux spell script(1) differently (busybox lacks -e); both
 * must flush the log as the screen comes (`-t 0`, `-f`): macOS otherwise writes whole 4 KiB
 * blocks and keeps the rest up to 30 s, so a frame's end shows only once more output
 * follows. script(1) needs a real pipe for its input, not Bun's socket: with `"stop"`, a
 * shell pipe that sends Ctrl+C once the test creates the `stop` file in the working
 * directory; with `"stdin"`, `cat`, passing on the keys the test writes to its stdin.
 */
export function inPty(log: string, command: string, input: "stop" | "stdin" = "stop") {
  const script =
    process.platform === "darwin"
      ? `/usr/bin/script -q -t 0 ${log} ${command}`
      : `script -q -e -f -c '${command}' ${log}`;
  const keys =
    input === "stdin" ? "cat" : `(while [ ! -f stop ]; do sleep 0.1; done; printf '\\003')`;
  return ["/bin/sh", "-c", `${keys} | ${script}`];
}

export { wire, importClient };
export type { ClientOptions, BuiltClient };

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

export { cellOf, clickOn };
