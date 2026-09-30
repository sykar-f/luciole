import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { act, type ReactNode } from "react";
import type { testRender } from "@opentui/react/test-utils";
import { z } from "zod";
import type { Application, ApplicationOptions } from "../packages/luciole/src/client";
import { readJsonFile } from "../packages/luciole/src/package-json";
import type { DraftStore } from "../examples/notes/components/draft";

/** `value`, which the test expects to exist: fails naming `what` when the domain has none. */
export function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Expected ${what}`);
  return value;
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
export async function until(check: () => boolean, timeout = 5000) {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > timeout) throw new Error("Condition timed out");
    await Bun.sleep(10);
  }
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
  const draft = store.get({ id, title: "", value: "", version: 0 });
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
  const dead = Bun.spawnSync(["true"]).pid;
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
