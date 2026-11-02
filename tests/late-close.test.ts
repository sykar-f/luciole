import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:os";
import { createTestRenderer } from "@opentui/core/testing";

const lateMessage = "NativeSession graceful close ran late; queued output was dropped";

test("installed OpenTUI exposes the identity-based close interruption seam", async () => {
  const { renderer } = await createTestRenderer({ width: 8, height: 2 });
  try {
    const session: unknown = Reflect.get(renderer, "nativeSession");
    expect(typeof session).toBe("object");
    expect(session).not.toBeNull();
    if (typeof session !== "object" || session === null) throw new Error("Missing native session");
    const method: unknown = Reflect.get(session, "isCloseInterruption");
    expect(typeof method).toBe("function");
    if (typeof method !== "function") throw new Error("Missing close interruption method");
    expect(method.call(session, new Error(lateMessage))).toBe(false);
  } finally {
    renderer.destroy();
    await renderer.closed;
  }
});

for (const ending of ["quit", "SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "failure"]) {
  for (const kind of [
    "late",
    "unrestored",
    "lookalike",
    "missing",
    "nonfunction",
    "method-throws",
    "session-getter-throws",
    "method-getter-throws",
  ]) {
    test(`${ending} with ${kind} close keeps the correct exit code`, async () => {
      const work = await mkdtemp(`${process.env.TMPDIR ?? "/tmp"}/luciole-late-close-`);
      const ready = Promise.withResolvers<void>();
      const child = Bun.spawn([process.execPath, "tests/late-close-client.ts"], {
        env: {
          ...process.env,
          LUCIOLE_DESKTOP: undefined,
          LUCIOLE_SESSION: undefined,
          XDG_STATE_HOME: work,
          CLOSE_KIND: kind,
          CLOSE_END: ending,
        },
        stdout: "ignore",
        stderr: "pipe",
        ipc(message: unknown) {
          if (typeof message === "object" && message !== null && "ready" in message)
            ready.resolve();
        },
        onExit() {
          ready.reject(new Error("Client exited before readiness"));
        },
      });
      try {
        await ready.promise;
        child.send({ end: true });
        const code = await child.exited;
        const errors = await new Response(child.stderr).text();
        const expected =
          kind !== "late" || ending === "failure"
            ? 1
            : ending === "SIGQUIT"
              ? 128 + constants.signals.SIGQUIT
              : 0;
        expect(code, errors).toBe(expected);
        if (kind === "late")
          expect(errors).toContain("Terminal close was late; queued output was dropped.");
        else {
          expect(errors).not.toContain("Terminal close was late;");
          expect(errors).toContain(lateMessage);
          expect(errors).not.toContain("Close detector failed");
        }
        if (ending === "failure") expect(errors).toContain(lateMessage);
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
        await rm(work, { recursive: true, force: true });
      }
    }, 15_000);
  }
}
