import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { serverStatus } from "../packages/core/src/launcher/managed";
import { eventually, until, WAIT_MS } from "./helpers";

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
      child.kill("SIGHUP");
      expect(await exited).toEqual(
        desktop ? { code: 0, signal: null } : { code: null, signal: "SIGHUP" },
      );
      expect(await Bun.file(join(state, "luciole/startup/sessions/startup.json")).exists()).toBe(
        !desktop,
      );
      if (desktop) {
        await until(() => {
          try {
            process.kill(ready.pid, 0);
            return false;
          } catch {
            return true;
          }
        }, WAIT_MS);
        const log = await Bun.file(join(state, "startup/server.log")).text();
        expect(log).toContain("the last Client left");
        expect(log).not.toContain("waiting 900 s for a Client");
        expect(await serverStatus(server.socket)).toBeUndefined();
      } else {
        await eventually(async () => (await serverStatus(ready.socket))?.graceUntil !== undefined);
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
