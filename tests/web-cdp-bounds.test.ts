import { expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod/mini";
import { alive, eventually, HANG_MS, temporaryDirectory } from "../scripts/pty/harness";

const Record = z.object({ chrome: z.number(), descendant: z.number(), profile: z.string() });
const root = join(import.meta.dir, "..");

async function fixture() {
  const directory = temporaryDirectory("cdp-bounds-", process.env.TMPDIR);
  const chrome = join(directory.path, "chrome");
  await Bun.write(
    chrome,
    `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, "web-cdp-chrome.ts")}' "$@"\n`,
  );
  chmodSync(chrome, 0o755);
  return {
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
] as const) {
  test(
    cause === "exceptions"
      ? "both evaluation methods preserve exception descriptions and text fallback"
      : `CDP owner cleans its Server, Chrome and descendants after ${cause}`,
    async () => {
      const f = await fixture();
      using _directory = f.directory;
      const child = Bun.spawn([process.execPath, join(root, "tests/web-cdp-owner.ts"), cause], {
        env: {
          ...process.env,
          CHROME: f.chrome,
          CDP_RECORD: f.record,
          OWNER_RECORD: f.owner,
          CDP_EXCEPTIONS: cause === "exceptions" ? "1" : undefined,
          STUCK_METHOD: cause === "startup" ? "Runtime.enable" : "Runtime.evaluate",
        },
        stdout: "ignore",
        stderr: "pipe",
      });
      const stderr = new Response(child.stderr).text();
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
        const server = Number(readFileSync(f.owner, "utf8"));
        if (cause === "SIGTERM" || cause === "SIGINT") child.kill(cause);
        // Arm the parent's deadline after launch, so this tests ownership rather than
        // imposing a startup-speed requirement while a browser build runs beside it.
        const timeout =
          cause === "timeout" ? setTimeout(() => child.kill("SIGKILL"), 200) : undefined;
        expect(
          await eventually(() => child.exitCode !== null || child.signalCode !== null, 4000),
        ).toBe(true);
        await child.exited;
        clearTimeout(timeout);
        if (cause === "exceptions") {
          expect(child.exitCode).toBe(0);
          expect(await stderr).toBe("");
        }
        if (cause === "error" || cause === "wait" || cause === "startup") {
          expect(await stderr).toContain(
            `${cause === "startup" ? "Runtime.enable" : "Runtime.evaluate"}: CDP target ws://127.0.0.1:`,
          );
          expect(await stderr).toContain("/stuck exceeded 200 ms");
        }
        let present: string[] = [];
        const cleaned = await eventually(() => {
          present = [];
          if (alive(server)) present.push(`server PID ${server}`);
          if (alive(record.chrome)) present.push(`chrome PID ${record.chrome}`);
          if (alive(record.descendant)) present.push(`descendant PID ${record.descendant}`);
          if (existsSync(record.profile))
            present.push(`profile ${record.profile} (chrome PID ${record.chrome})`);
          return present.length === 0;
        }, 3000);
        expect(cleaned, `cleanup still has: ${present.join(", ")}`).toBe(true);
        expect(existsSync(record.profile)).toBe(false);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await child.exited;
      }
    },
  );
}
