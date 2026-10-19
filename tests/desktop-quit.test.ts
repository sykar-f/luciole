import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { NativeStatus } from "@opentui/core";

const cases = [
  ...["closed-output", "internal", "other-operation", "lookalike"].map((mode) => ({
    mode,
    desktop: true,
    interrupted: false,
  })),
  { mode: "closed-output", desktop: false, interrupted: false },
  { mode: "closed-output", desktop: true, interrupted: true },
];
for (const { mode, desktop, interrupted } of cases) {
  test(`${desktop ? "desktop" : "terminal"} ${interrupted ? "interruption" : "voluntary quit"} with ${mode}`, async () => {
    const work = await mkdtemp("/tmp/luciole-quit-");
    let left = false;
    const events = Bun.serve({
      port: 0,
      fetch() {
        left = true;
        return new Response(null, { status: 204 });
      },
    });
    const ready = Promise.withResolvers<void>();
    const failure = Promise.withResolvers<unknown>();
    const child = Bun.spawn([process.execPath, "tests/desktop-quit-client.ts"], {
      env: {
        ...process.env,
        LUCIOLE_DESKTOP: desktop ? "1" : undefined,
        QUIT_INTERRUPTED: interrupted ? "1" : undefined,
        LUCIOLE_SESSION: undefined,
        XDG_STATE_HOME: work,
        QUIT_EVENTS: events.url.href,
        QUIT_FAILURE: mode,
      },
      terminal: { cols: 80, rows: 24, data() {} },
      stderr: "pipe",
      ipc(message) {
        if (message?.ready) ready.resolve();
        if (message?.failure !== undefined) failure.resolve(message);
      },
      onExit() {
        ready.reject(new Error("Client exited before renderer readiness"));
      },
    });
    try {
      await ready.promise;
      child.send({ quit: true });
      const code = await child.exited;
      const errors = await new Response(child.stderr).text();
      expect(left).toBe(!interrupted);
      expect(await readdir(join(work, "luciole/quit/sessions"))).toHaveLength(interrupted ? 1 : 0);
      expect(await failure.promise).toMatchObject({
        operation:
          mode === "other-operation"
            ? "ot_scene_flush"
            : mode === "lookalike"
              ? undefined
              : "ot_session_drain_stdout",
        failure:
          mode === "lookalike"
            ? "Error"
            : mode === "internal"
              ? NativeStatus.InternalError
              : NativeStatus.OutputFailed,
      });
      expect(code, errors).toBe(mode === "closed-output" && desktop && !interrupted ? 0 : 1);
    } finally {
      if (child.exitCode === null) process.kill(child.pid, "SIGKILL");
      await child.exited;
      child.terminal?.close();
      await events.stop(true);
      await rm(work, { recursive: true, force: true });
    }
  }, 15_000);
}
