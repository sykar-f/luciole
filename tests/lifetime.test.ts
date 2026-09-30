import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "../packages/luciole/src/connect";
import { messageOf } from "../packages/luciole/src/guards";
import { parseDuration } from "../packages/luciole/src/launcher/lifetime";
import {
  ensureServer,
  serverId,
  serverStatus,
  type EnsureOptions,
} from "../packages/luciole/src/launcher/managed";
import { rejectionOf, until } from "./helpers";

let work: string, runtime: string;
beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "luciole-lifetime-"));
  // Short: socket paths must fit sun_path.
  runtime = await mkdtemp("/tmp/luciole-rt-");
});
afterAll(async () => {
  await rm(work, { recursive: true, force: true });
  await rm(runtime, { recursive: true, force: true });
});

let keys = 0;
function options(extra: Partial<EnsureOptions> & { buildId?: string } = {}): EnsureOptions {
  const buildId = extra.buildId ?? "build-1";
  return {
    id: serverId(`local:test-${++keys}`),
    name: "lifetime",
    buildId,
    command: [process.execPath, "--conditions=react-server", "tests/lifetime-server.ts"],
    graceMs: 60_000,
    directories: { state: join(work, "state") },
    env: {
      ...process.env,
      XDG_RUNTIME_DIR: runtime,
      TEST_BUILD_ID: buildId,
      LUCIOLE_WATCHDOG_MS: "600",
    },
    ...extra,
  };
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function eventually(check: () => Promise<boolean>, timeout = 5000) {
  const deadline = performance.now() + timeout;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error("Condition timed out");
    await Bun.sleep(20);
  }
}
async function gone(pid: number, timeout = 5000) {
  await until(() => !alive(pid), timeout);
}
/** A Client of that Server, as src/connect.ts keeps one alive. */
const client = (url: string, id: string) =>
  connect(url, undefined, { LUCIOLE_LIFETIME_CLIENT: id, LUCIOLE_PING_MS: "100" });

test("durations read as users write them", () => {
  expect(parseDuration("15m")).toBe(900_000);
  expect(parseDuration("30s")).toBe(30_000);
  expect(parseDuration("45")).toBe(45_000);
  expect(parseDuration("1h")).toBe(3_600_000);
  expect(parseDuration("250ms")).toBe(250);
  expect(parseDuration("0")).toBe(0);
  expect(() => parseDuration("soon")).toThrow("Invalid duration");
});

test("a Client that quits on purpose stops the Server at once", async () => {
  const server = await ensureServer({ ...options(), client: "a", attach: true });
  expect(server.reattached).toBe(false);
  const connection = await client(server.url, "a");
  await connection.managed?.leave();
  await gone(server.pid);
  expect(await Bun.file(server.socket).exists()).toBe(false);
  server.release();
});

test("a crashed Client leaves the Server in grace; the next launch attaches to it", async () => {
  const setup = options();
  const first = await ensureServer({ ...setup, client: "a", attach: true });
  // The launcher's pipe closes without a leave: a crash.
  first.release();
  await eventually(async () => (await serverStatus(first.socket))?.graceUntil !== undefined);
  const again = await ensureServer({ ...setup, client: "b", attach: true });
  expect(again).toMatchObject({ reattached: true, pid: first.pid, socket: first.socket });
  const connection = await client(again.url, "b");
  await eventually(async () => (await serverStatus(again.socket))?.graceUntil === undefined);
  expect((await serverStatus(again.socket))?.clients).toBe(1);
  await connection.managed?.leave();
  await gone(first.pid);
});

test("grace expires: the Server stops when no Client came back", async () => {
  const server = await ensureServer({ ...options(), graceMs: 300, client: "a", attach: true });
  server.release();
  await gone(server.pid);
});

test("the watchdog: pings keep the Server; silence past its period loses the Client", async () => {
  // No launcher pipe here, as on a remote host: only pings tell the Server.
  const server = await ensureServer({ ...options(), graceMs: 0 });
  const connection = await client(server.url, "pinging");
  // Pinged every 100 ms: alive well past the 600 ms watchdog period.
  await Bun.sleep(1500);
  expect(alive(server.pid)).toBe(true);
  // A Server nobody pings loses its (absent) Client after one period; no grace: it stops.
  const lonely = await ensureServer({ ...options(), graceMs: 0 });
  await gone(lonely.pid, 3000);
  await connection.managed?.leave();
  await gone(server.pid);
});

test("another build on the same key is stopped and replaced", async () => {
  const setup = options();
  const old = await ensureServer(setup);
  const next = await ensureServer({
    ...setup,
    buildId: "build-2",
    env: { ...setup.env, TEST_BUILD_ID: "build-2" },
  });
  expect(next.reattached).toBe(false);
  expect(next.pid).not.toBe(old.pid);
  await gone(old.pid);
  expect((await serverStatus(next.socket))?.buildId).toBe("build-2");
  await fetch("http://localhost/lifetime/stop", { method: "POST", unix: next.socket });
  await gone(next.pid);
});

test("a Server that cannot start is explained from its log", async () => {
  const failing = options({
    command: [process.execPath, "-e", "console.error('no database'); process.exit(3)"],
  });
  expect(messageOf(await rejectionOf(ensureServer(failing)))).toContain("no database");
});

test("pings follow a Server going away and coming back", async () => {
  const setup = options();
  const server = await ensureServer(setup);
  const seen: boolean[] = [];
  const connection = await client(server.url, "watcher");
  connection.managed?.watch((reachable) => seen.push(reachable));
  await Bun.sleep(300);
  await fetch("http://localhost/lifetime/stop", { method: "POST", unix: server.socket });
  await until(() => seen.includes(false));
  const back = await ensureServer(setup);
  await until(() => seen.at(-1) === true);
  expect(seen).toEqual([false, true]);
  await connection.managed?.leave();
  await gone(back.pid);
});
