import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { serverStatus } from "../packages/core/src/launcher/managed";

/** Subscribe before checking: shutdown is observed through filesystem events, not polls. */
function observe(path: string, condition: () => Promise<boolean>) {
  const result = Promise.withResolvers<void>();
  const inspect = () =>
    void condition().then((ready) => {
      if (ready) result.resolve();
    }, result.reject);
  const watcher = watch(path, inspect);
  inspect();
  return { promise: result.promise, [Symbol.dispose]: () => watcher.close() };
}

const Ready = z.object({ socket: z.string(), pid: z.number() });
for (const desktop of [true, false]) {
  test(`${desktop ? "desktop" : "terminal"} hangup during URL resolution keeps its lifetime meaning`, async () => {
    const work = await mkdtemp("/tmp/luciole-start-");
    const state = join(work, "state");
    const child = spawn(process.execPath, ["tests/desktop-startup-client.ts"], {
      env: {
        ...process.env,
        LUCIOLE_DESKTOP: desktop ? "1" : undefined,
        XDG_RUNTIME_DIR: work,
        XDG_STATE_HOME: state,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let errors = "";
    child.stderr?.on("data", (chunk) => (errors += chunk));
    const exited = new Promise((done) =>
      child.once("exit", (code, signal) => done({ code, signal })),
    );
    let server: z.infer<typeof Ready> | undefined;
    try {
      const ready = await new Promise<z.infer<typeof Ready>>((done, fail) => {
        child.on("message", (message) => {
          const ready = Ready.safeParse(message);
          if (ready.success) done(ready.data);
        });
        child.once("exit", () => fail(new Error(`Client exited before barrier: ${errors}`)));
      });
      server = ready;
      expect((await serverStatus(ready.socket))?.clients).toBe(1);
      const logFile = Bun.file(join(state, "startup/server.log"));
      using changed = observe(desktop ? join(work, "luciole") : join(state, "startup"), async () =>
        desktop
          ? !existsSync(ready.socket)
          : (await logFile.text()).includes("waiting 900 s for a Client"),
      );
      child.kill("SIGHUP");
      expect(await exited).toEqual(
        desktop ? { code: 0, signal: null } : { code: null, signal: "SIGHUP" },
      );
      expect(await Bun.file(join(state, "luciole/startup/sessions/startup.json")).exists()).toBe(
        !desktop,
      );
      if (desktop) {
        await changed.promise;
        const log = await Bun.file(join(state, "startup/server.log")).text();
        expect(log).toContain("the last Client left");
        expect(log).not.toContain("waiting 900 s for a Client");
        expect(await serverStatus(server.socket)).toBeUndefined();
      } else {
        await changed.promise;
        expect((await serverStatus(ready.socket))?.graceUntil).toBeDefined();
        expect(await serverStatus(server.socket)).toMatchObject({ clients: 0 });
      }
    } finally {
      child.kill("SIGKILL");
      if (server) {
        await fetch("http://localhost/lifetime/stop", {
          method: "POST",
          unix: server.socket,
        }).catch(() => {});
      }
      await rm(work, { recursive: true, force: true });
    }
  }, 15_000);
}

test("a desktop hangup before launch planning exits without creating a Server", async () => {
  const work = await mkdtemp("/tmp/luciole-before-");
  const child = spawn(process.execPath, ["tests/desktop-startup-before-server.ts"], {
    env: { ...process.env, LUCIOLE_DESKTOP: "1", XDG_RUNTIME_DIR: work },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const exited = new Promise((done) =>
    child.once("exit", (code, signal) => done({ code, signal })),
  );
  try {
    await new Promise<void>((done, fail) => {
      child.once("message", () => done());
      child.once("exit", () => fail(new Error("Launcher exited before barrier")));
    });
    child.kill("SIGHUP");
    expect(await exited).toEqual({ code: 0, signal: null });
    expect(await Bun.file(join(work, "luciole/startup.sock")).exists()).toBe(false);
  } finally {
    child.kill("SIGKILL");
    await rm(work, { recursive: true, force: true });
  }
});

test("a desktop hangup while its managed Server starts waits to leave voluntarily", async () => {
  const work = await mkdtemp("/tmp/luciole-starting-");
  const arrived = Promise.withResolvers<z.infer<typeof Ready>>();
  const release = Promise.withResolvers<void>();
  const barrier = Bun.serve({
    port: 0,
    async fetch(request) {
      arrived.resolve(Ready.parse(await request.json()));
      await release.promise;
      return new Response("continue");
    },
  });
  const child = spawn(process.execPath, ["tests/desktop-startup-client.ts"], {
    env: {
      ...process.env,
      LUCIOLE_DESKTOP: "1",
      XDG_RUNTIME_DIR: work,
      XDG_STATE_HOME: join(work, "state"),
      STARTUP_BARRIER: barrier.url.href,
    },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const exited = new Promise((done) =>
    child.once("exit", (code, signal) => done({ code, signal })),
  );
  child.once("exit", () => arrived.reject(new Error("Client exited before readiness barrier")));
  let server: z.infer<typeof Ready> | undefined;
  try {
    server = await arrived.promise;
    // The desktop coordinator's listener is already installed. A second listener
    // acknowledges delivery so releasing readiness cannot race the first signal.
    const ready = server;
    using stopped = observe(join(work, "luciole"), async () => !existsSync(ready.socket));
    child.kill("SIGHUP");
    await new Promise<void>((done) => child.once("message", () => done()));
    // A second hangup must not take the default action during asynchronous cleanup.
    child.kill("SIGHUP");
    await new Promise<void>((done) => child.once("message", () => done()));
    release.resolve();
    expect(await exited).toEqual({ code: 0, signal: null });
    await stopped.promise;
    const log = await Bun.file(join(work, "state/startup/server.log")).text();
    expect(log).toContain("stopping: the last Client left");
    expect(log).not.toContain("waiting 900 s for a Client");
  } finally {
    release.resolve();
    child.kill("SIGKILL");
    if (server) {
      await fetch("http://localhost/lifetime/stop", { method: "POST", unix: server.socket }).catch(
        () => {},
      );
    }
    await barrier.stop(true);
    await rm(work, { recursive: true, force: true });
  }
}, 15_000);
