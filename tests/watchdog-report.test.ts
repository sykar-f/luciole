/** Exercise the preload in a child: a synchronous block must not block its watchdog. */
import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const watchdog = join(import.meta.dir, "watchdog.ts");
const label = "a deliberately blocked main thread";

async function blocked(path: string | undefined, tool?: string) {
  const directory = await mkdtemp(join(tmpdir(), "watchdog-report-"));
  let stop: (() => void) | undefined;
  try {
    const filename = join(directory, "blocked.test.ts");
    await writeFile(
      filename,
      `import { test } from "bun:test";
import * as watchdog from ${JSON.stringify(watchdog)};
test("a passing first test", () => {});
test(${JSON.stringify(label)}, () => {
  Reflect.get(watchdog, "watchdogTest")?.(${JSON.stringify(label)});
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
});
`,
    );
    if (tool !== undefined) {
      const sampler = join(directory, process.platform === "darwin" ? "sample" : "gdb");
      await writeFile(sampler, tool);
      await chmod(sampler, 0o755);
    }
    const child = Bun.spawn([process.execPath, "test", "--preload", watchdog, filename], {
      cwd: directory,
      env: {
        ...process.env,
        PATH: path ?? directory,
        LUCIOLE_TEST_BLOCKED_MS: "2500",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    stop = () => child.kill("SIGKILL");
    // An independent parent deadline catches a broken watchdog, never a retry.
    const guard = setTimeout(() => child.kill("SIGKILL"), 7000);
    try {
      const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
      expect(code).not.toBe(0);
      expect(stderr).toContain(filename);
      expect(stderr).toContain(`test start #2, test: ${label}`);
      expect(stderr).toContain("a synchronous call that never returns");
      return stderr;
    } finally {
      clearTimeout(guard);
    }
  } finally {
    stop?.();
    await rm(directory, { recursive: true, force: true });
  }
}

test("a blocked worker names its test and reports absent sampling tools", async () => {
  const stderr = await blocked(undefined);
  expect(stderr).toContain("Native stack unavailable: no sampling tool exists");
});

test.if(process.platform === "darwin")(
  "a blocked worker includes a native macOS stack",
  async () => {
    const stderr = await blocked(process.env.PATH);
    expect(stderr).toContain("Call graph:");
    expect(stderr).toContain("Sampling tool exited with code 0");
  },
);

test("a sampling tool that stalls cannot postpone the watchdog kill", async () => {
  const stderr = await blocked(undefined, "#!/bin/sh\necho sampler-started\nexec /bin/sleep 30\n");
  expect(stderr).toContain("sampler-started");
  expect(stderr).toContain("Native stack capture stopped at the kill deadline");
});

test("a sampling tool's output is bounded", async () => {
  const stderr = await blocked(undefined, "#!/bin/sh\n/usr/bin/head -c 65536 /dev/zero\n");
  expect(stderr).toContain("Native stack truncated at 32768 bytes");
  expect(stderr.length).toBeLessThan(35000);
});
