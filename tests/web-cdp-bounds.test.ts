import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod/mini";
import { alive, eventually, HANG_MS, temporaryDirectory } from "../scripts/pty/harness";

const Record = z.object({
  chrome: z.number(),
  guard: z.number(),
  descendant: z.number(),
  profile: z.string(),
});
const Owner = z.object({ server: z.number(), guard: z.number() });
const Guard = z.object({
  guard: z.number(),
  exitCode: z.number(),
  cleanup: z.object({
    ok: z.boolean(),
    removed: z.optional(z.string()),
    error: z.optional(z.string()),
  }),
});

function report(directory: string, pid: number) {
  const path = join(directory, `${pid}.json`);
  return existsSync(path) ? Guard.parse(JSON.parse(readFileSync(path, "utf8"))) : undefined;
}
function diagnostics(directory: string, guards: number[]) {
  return guards
    .map(
      (pid) =>
        `guard PID ${pid} ${alive(pid) ? "running" : "exited"}: ${JSON.stringify(report(directory, pid) ?? "no cleanup result")}`,
    )
    .join("\n");
}
function waitForGuards(guards: number[], onWaiting = () => {}) {
  // Synchronize on the actual owners of cleanup. The existing resource-survivor
  // window below starts only after these processes have finished their finally.
  const waiting = eventually(() => guards.every((pid) => !alive(pid)));
  onWaiting();
  return waiting;
}
const root = join(import.meta.dir, "..");

async function fixture() {
  const directory = temporaryDirectory("cdp-bounds-", process.env.TMPDIR);
  const chrome = join(directory.path, "chrome");
  await Bun.write(
    chrome,
    `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, "web-cdp-chrome.ts")}' "$@"\n`,
  );
  chmodSync(chrome, 0o755);
  const guards = join(directory.path, "guards");
  mkdirSync(guards);
  return {
    guards,
    directory,
    chrome,
    record: join(directory.path, "chrome.json"),
    owner: join(directory.path, "owner"),
  };
}

for (const cause of [
  "error",
  "wait",
  "startup",
  "normal",
  "exceptions",
  "SIGTERM",
  "SIGINT",
  "timeout",
  "paused-guard",
  "removal-error",
  "deferred-report",
  "missing-report",
  "suppressed-error",
] as const) {
  test(
    cause === "exceptions"
      ? "both evaluation methods preserve exception descriptions and text fallback"
      : `CDP owner cleans its Server, Chrome and descendants after ${cause}`,
    async () => {
      const f = await fixture();
      using _directory = f.directory;
      const child = Bun.spawn(
        [
          process.execPath,
          join(root, "tests/web-cdp-owner.ts"),
          cause === "removal-error" || cause === "deferred-report" || cause === "missing-report"
            ? "normal"
            : cause === "suppressed-error"
              ? "error"
              : cause,
        ],
        {
          env: {
            ...process.env,
            CHROME: f.chrome,
            CDP_RECORD: f.record,
            OWNER_RECORD: f.owner,
            LUCIOLE_TEST_GUARD_RECORDS: f.guards,
            LUCIOLE_TEST_GUARD_REMOVE_ERROR:
              cause === "removal-error" || cause === "suppressed-error" ? "1" : undefined,
            LUCIOLE_TEST_GUARD_DEFER_REPORT: cause === "deferred-report" ? "1" : undefined,
            LUCIOLE_TEST_GUARD_DISCONNECT: cause === "missing-report" ? "1" : undefined,
            CDP_EXCEPTIONS: cause === "exceptions" ? "1" : undefined,
            STUCK_METHOD: cause === "startup" ? "Runtime.enable" : "Runtime.evaluate",
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      const stderr = new Response(child.stderr).text();
      let guards: number[] = [];
      let paused: number | undefined;
      let profile: string | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const ready = await eventually(
          () =>
            (existsSync(f.owner) && existsSync(f.record)) ||
            child.exitCode !== null ||
            child.signalCode !== null,
          HANG_MS,
        );
        if (!ready) {
          child.kill("SIGKILL");
          await child.exited;
          throw new Error(`owner did not start: ${await stderr}`);
        }
        const record = Record.parse(JSON.parse(readFileSync(f.record, "utf8")));
        profile = record.profile;
        const { server, guard: serverGuard } = Owner.parse(
          JSON.parse(readFileSync(f.owner, "utf8")),
        );
        guards = [serverGuard, record.guard];
        const survivors = () => {
          const present: string[] = [];
          if (alive(server)) present.push(`server PID ${server}`);
          if (alive(record.chrome)) present.push(`chrome PID ${record.chrome}`);
          if (alive(record.descendant)) present.push(`descendant PID ${record.descendant}`);
          if (existsSync(record.profile))
            present.push(`profile ${record.profile} (chrome PID ${record.chrome})`);
          return present;
        };
        const state = () =>
          `cleanup still has: ${survivors().join(", ")}\n${diagnostics(f.guards, guards)}`;
        if (cause === "paused-guard") {
          process.kill(record.guard, "SIGSTOP");
          paused = record.guard;
          child.kill("SIGKILL");
        }
        if (cause === "SIGTERM" || cause === "SIGINT") child.kill(cause);
        // Arm the parent's deadline after launch, so this tests ownership rather than
        // imposing a startup-speed requirement while a browser build runs beside it.
        timeout = cause === "timeout" ? setTimeout(() => child.kill("SIGKILL"), 200) : undefined;
        expect(
          await eventually(() => child.exitCode !== null || child.signalCode !== null, 4000),
          state(),
        ).toBe(true);
        await child.exited;
        clearTimeout(timeout);
        if (cause === "missing-report") {
          expect(child.exitCode, await stderr).not.toBe(0);
          expect(await stderr).toContain("no cleanup result");
        }
        if (cause === "deferred-report") {
          expect(child.exitCode, await stderr).toBe(0);
          expect(await stderr).toBe("");
        }
        if (cause === "exceptions") {
          expect(child.exitCode).toBe(0);
          expect(await stderr).toBe("");
        }
        if (
          cause === "error" ||
          cause === "wait" ||
          cause === "startup" ||
          cause === "suppressed-error"
        ) {
          expect(await stderr).toContain(
            `${cause === "startup" ? "Runtime.enable" : "Runtime.evaluate"}: CDP target ws://127.0.0.1:`,
          );
          expect(await stderr).toContain("/stuck exceeded 200 ms");
        }
        const guardsExited = await waitForGuards(guards, () => {
          if (paused !== undefined) {
            // The observer has started waiting with cleanup deliberately suspended.
            expect(alive(paused)).toBe(true);
            expect(existsSync(record.profile)).toBe(true);
            process.kill(paused, "SIGCONT");
            paused = undefined;
          }
        });
        const guardStatus = state();
        expect(guardsExited, guardStatus).toBe(true);
        if (cause === "suppressed-error") {
          expect(await stderr).toContain("Disposal error:");
          expect(await stderr).toContain("Suppressed original error:");
        }
        if (cause === "removal-error" || cause === "suppressed-error") {
          expect(child.exitCode, await stderr).not.toBe(0);
          expect(await stderr).toContain("injected profile removal failure");
          expect(await stderr).toContain("EIO");
          expect(await stderr).toContain("fake Chrome stderr retained through cleanup");
          expect(await stderr).toContain(record.profile);
          const result = report(f.guards, record.guard);
          expect(result?.exitCode, guardStatus).toBe(1);
          expect(result?.cleanup.ok, guardStatus).toBe(false);
          expect(result?.cleanup.error).toContain("EIO");
          expect(result?.cleanup.error).toContain(record.profile);
          expect(existsSync(record.profile)).toBe(true);
          return;
        }
        for (const pid of guards) expect(report(f.guards, pid)?.cleanup.ok, guardStatus).toBe(true);
        expect(report(f.guards, record.guard)?.cleanup.removed, guardStatus).toBe(record.profile);
        let present: string[] = [];
        const cleaned = await eventually(() => {
          present = survivors();
          return present.length === 0;
        }, 3000);
        expect(cleaned, `cleanup still has: ${present.join(", ")}\n${guardStatus}`).toBe(true);
        expect(existsSync(record.profile)).toBe(false);
      } finally {
        clearTimeout(timeout);
        if (paused !== undefined) process.kill(paused, "SIGCONT");
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await child.exited;
        await eventually(() => guards.every((pid) => !alive(pid)));
        if ((cause === "removal-error" || cause === "suppressed-error") && profile)
          rmSync(profile, { recursive: true, force: true });
      }
    },
  );
}
