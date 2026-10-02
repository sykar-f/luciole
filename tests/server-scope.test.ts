import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  launchBase,
  launchOf,
  LAUNCH_VARIABLE,
  planLaunch,
  remoteEnvironment,
} from "../packages/core/src/launcher/launch-key";
import {
  ensureServer,
  serverId,
  serverSocket,
  serverStatus,
  type EnsureOptions,
} from "../packages/core/src/launcher/managed";
import { argsFingerprint, encodeLaunchArgs } from "../packages/core/src/args";
import { leaveCrashedSession } from "./helpers";

let work: string, runtime: string, env: NodeJS.ProcessEnv;
beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "luciole-scope-"));
  // Short: socket paths must fit sun_path.
  runtime = await mkdtemp("/tmp/luciole-sc-");
  env = {
    ...process.env,
    XDG_RUNTIME_DIR: runtime,
    XDG_STATE_HOME: join(work, "state"),
    TEST_BUILD_ID: "build-1",
    LUCIOLE_WATCHDOG_MS: "600",
  };
});
afterAll(async () => {
  for (const entry of readdirSync(join(runtime, "luciole")).filter((e) => e.endsWith(".sock")))
    await fetch("http://localhost/lifetime/stop", {
      method: "POST",
      unix: join(runtime, "luciole", entry),
    }).catch(() => undefined);
  await rm(work, { recursive: true, force: true });
  await rm(runtime, { recursive: true, force: true });
});

const server = (key: string, extra: Partial<EnsureOptions> = {}) =>
  ensureServer({
    id: serverId(key),
    name: "scope",
    buildId: "build-1",
    command: [process.execPath, "--conditions=react-server", "tests/lifetime-server.ts"],
    graceMs: 60_000,
    directories: { state: join(work, "state") },
    env,
    ...extra,
  });
const plan = (extra: Partial<Parameters<typeof planLaunch>[0]> = {}) =>
  planLaunch({
    name: "scope",
    target: "local:/apps/coder",
    scope: "per-launch",
    cwd: "/projects/a",
    fingerprint: "f1",
    buildId: "build-1",
    env,
    ...extra,
  });

test("the scope decides what a key holds: the directory, the arguments, the launch", async () => {
  const at = { cwd: "/projects/a", fingerprint: "f1" };
  expect(launchBase("local:/apps/notes", { scope: "shared", cwd: "/x" })).toBe("local:/apps/notes");
  expect(launchBase("local:/apps/coder", { scope: "shared", ...at })).toBe("local:/apps/coder#f1");
  expect(launchBase("local:/apps/coder", { scope: "per-directory", ...at })).toBe(
    "local:/apps/coder@/projects/a#f1",
  );
  const shared = await plan({ scope: "shared" });
  expect(shared.key).toBe("local:/apps/coder#f1");
  expect(launchOf(shared.env, "/")).toEqual({ v: 1, scope: "shared", cwd: "/projects/a" });
  // Per launch: a Server each, even with the same arguments in the same directory.
  const [one, two] = await Promise.all([plan(), plan()]);
  expect(one.key).toStartWith("local:/apps/coder@/projects/a#f1!");
  expect(two.key).not.toBe(one.key);
  expect(launchOf(one.env, "/").id).toBe(one.key.split("!")[1]);
  // A Server started by hand is shared, in its own directory.
  expect(launchOf({}, "/here")).toEqual({ v: 1, scope: "shared", cwd: "/here" });
  expect(() => launchOf({ [LAUNCH_VARIABLE]: "{" }, "/")).toThrow("not a launch description");
});

test("a relaunch claims the session of a crashed launch whose Server is in grace", async () => {
  const crashed = await plan({ fresh: true });
  const running = await server(crashed.key, { env: { ...env, ...crashed.env } });
  expect((await serverStatus(serverSocket(serverId(crashed.key), env)))?.launch).toBe(
    crashed.launch.id,
  );
  await leaveCrashedSession(join(work, "state"), "scope", crashed.key, "/notes/7");
  // Another crashed launch, whose Server is gone: nothing to reattach there.
  await leaveCrashedSession(join(work, "state"), "scope", `${crashed.key}-gone`, "/x");
  // Another directory, or other arguments, are other launches.
  await leaveCrashedSession(
    join(work, "state"),
    "scope",
    crashed.key.replace("/projects/a", "/projects/b"),
    "/y",
  );
  expect((await plan({ fresh: true })).session).toBeUndefined();
  // Two relaunches at once: one takes it, the other starts afresh.
  const [first, second] = await Promise.all([plan(), plan()]);
  const claimed = [first, second].filter((p) => p.session);
  expect(claimed).toHaveLength(1);
  const [back] = claimed;
  expect(back?.key).toBe(crashed.key);
  expect(back?.launch.id).toBe(crashed.launch.id);
  // Marked with this process until the Client it starts opens it.
  const file = join(work, "state/luciole/scope/sessions", `${back?.session}.json`);
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
    pid: process.pid,
    server: crashed.key,
    entries: [{ href: "/" }, { href: "/notes/7" }],
  });
  const again = await server(crashed.key, { env: { ...env, ...crashed.env } });
  expect(again).toMatchObject({ reattached: true, pid: running.pid });
});

test("a Server holding other arguments is never reattached", async () => {
  const key = "local:/apps/fingerprint";
  const withArgs = (name: string) => ({
    env: { ...env, TEST_ARGS: "1", LUCIOLE_ARGS: encodeLaunchArgs(["--name", name]) },
    fingerprint: argsFingerprint({ name }),
  });
  const first = await server(key, withArgs("ada"));
  expect(await server(key, withArgs("ada"))).toMatchObject({ reattached: true, pid: first.pid });
  // Same key, other arguments (a collision, or an older launcher): replaced, not inherited.
  const other = await server(key, withArgs("bob"));
  expect(other.reattached).toBe(false);
  expect(other.pid).not.toBe(first.pid);
});

test("--on sends the arguments and the launch; the remote directory completes them", () => {
  expect(
    remoteEnvironment(
      JSON.stringify({
        args: { v: 1, argv: ["-H", "codex"] },
        launch: { scope: "per-launch", id: "L1" },
      }),
      "/home/ada",
    ),
  ).toEqual({
    LUCIOLE_ARGS: JSON.stringify({ v: 1, argv: ["-H", "codex"], cwd: "/home/ada" }),
    LUCIOLE_LAUNCH: JSON.stringify({ v: 1, scope: "per-launch", id: "L1", cwd: "/home/ada" }),
  });
  expect(remoteEnvironment("{}", "/")).toEqual({});
  expect(() => remoteEnvironment('{"launch":{"scope":"all"}}', "/")).toThrow("env-stdin");
});
