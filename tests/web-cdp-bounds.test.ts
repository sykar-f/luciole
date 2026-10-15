import { expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod/mini";
import { alive, eventually, temporaryDirectory } from "../scripts/pty/harness";

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
  "SIGTERM",
  "SIGINT",
  "timeout",
] as const) {
  test(`CDP owner cleans its Server, Chrome and descendants after ${cause}`, async () => {
    const f = await fixture();
    using _directory = f.directory;
    const child = Bun.spawn([process.execPath, join(root, "tests/web-cdp-owner.ts"), cause], {
      env: { ...process.env, CHROME: f.chrome, CDP_RECORD: f.record, OWNER_RECORD: f.owner },
      stdout: "ignore",
      stderr: "pipe",
      ...(cause === "timeout" ? { timeout: 3000, killSignal: "SIGKILL" } : {}),
    });
    const stderr = new Response(child.stderr).text();
    try {
      expect(await eventually(() => existsSync(f.owner) && existsSync(f.record), 2000)).toBe(true);
      const record = Record.parse(JSON.parse(readFileSync(f.record, "utf8")));
      const server = Number(readFileSync(f.owner, "utf8"));
      if (cause === "SIGTERM" || cause === "SIGINT") child.kill(cause);
      expect(
        await eventually(() => child.exitCode !== null || child.signalCode !== null, 4000),
      ).toBe(true);
      await child.exited;
      if (cause === "error" || cause === "wait" || cause === "startup") {
        expect(await stderr).toContain(
          `${cause === "startup" ? "Runtime.enable" : "Runtime.evaluate"}: CDP target ws://127.0.0.1:`,
        );
        expect(await stderr).toContain("/stuck exceeded 200 ms");
      }
      expect(
        await eventually(
          () =>
            !alive(server) &&
            !alive(record.chrome) &&
            !alive(record.descendant) &&
            !existsSync(record.profile),
          3000,
        ),
      ).toBe(true);
      expect(existsSync(record.profile)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  });
}
