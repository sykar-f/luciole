/** Exercise the preload in a child: a synchronous block must not block its watchdog. */
import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const watchdog = join(import.meta.dir, "watchdog.ts");
const label = "a deliberately blocked main thread";

async function blocked(path: string | undefined, tool?: string, named = true, blockedMs = 2500) {
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
${named ? `  Reflect.get(watchdog, "watchdogTest")?.(${JSON.stringify(label)});` : ""}
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
        LUCIOLE_TEST_BLOCKED_MS: String(blockedMs),
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
      expect(stderr).toContain(
        `test start #2, test: ${named ? label : "unavailable (no test name supplied)"}`,
      );
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
  "a blocked worker reports a native macOS stack or its capture deadline",
  async () => {
    const stderr = await blocked(process.env.PATH);
    // A loaded runner may reach the fixed kill deadline before sample flushes
    // its call graph. That bounded interruption is also a correct report.
    expect(stderr).toMatch(/Call graph:|Native stack capture stopped at the kill deadline/);
  },
);

test("a sampler taking more than two seconds finishes before the kill", async () => {
  // Base: capture lead <= 2000 ms, so the 2300 ms sampler cannot finish.
  // Fixed: 4500 * 0.8 - 4500 / 10 = 3150 ms minimum before startup costs;
  // minus 2300 ms sampling and ~100 ms startup leaves ~750 ms of margin.
  const stderr = await blocked(
    undefined,
    "#!/bin/sh\necho sampler-started\n/bin/sleep 2.3\necho native-stack-complete\n",
    true,
    4500,
  );
  expect(stderr).toContain("sampler-started");
  expect(stderr).toContain("native-stack-complete");
  expect(stderr).toContain("Sampling tool exited with code 0");
  expect(stderr).not.toContain("Native stack capture stopped at the kill deadline");
});

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

test("an unmarked blocked test still reports its start ordinal", async () => {
  await blocked(undefined, undefined, false);
});

test("a debugger that suspends the worker cannot suspend its kill deadline", async () => {
  const target = process.platform === "darwin" ? "$1" : "$2";
  const stderr = await blocked(
    undefined,
    `#!/bin/sh\nkill -STOP "${target}"\necho target-suspended\nexec /bin/sleep 30\n`,
  );
  expect(stderr).toContain("target-suspended");
  expect(stderr).toContain("Native stack capture stopped at the kill deadline");
});

test("watchdog teardown cancels a reporter already sampling a recovered worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watchdog-recovered-"));
  try {
    const flag = join(directory, "sampling");
    const sampler = join(directory, process.platform === "darwin" ? "sample" : "gdb");
    await writeFile(sampler, `#!/bin/sh\necho started > "${flag}"\nexec /bin/sleep 30\n`);
    await chmod(sampler, 0o755);
    const script = join(directory, "recover.ts");
    await writeFile(
      script,
      `import { Worker } from "node:worker_threads";
const watcher = new Worker(${JSON.stringify(join(import.meta.dir, "watchdog-thread.ts"))}, {workerData: 2500});
watcher.postMessage({file: "recovered", phase: "test", ordinal: 1});
while (!(await Bun.file(${JSON.stringify(flag)}).exists())) await Bun.sleep(10);
const stopped = new Promise(resolve => watcher.once("message", resolve));
watcher.postMessage({stop: true}); await stopped; await watcher.terminate();
await Bun.sleep(2600); console.error("recovered worker survived");
`,
    );
    const child = Bun.spawn([process.execPath, script], {
      cwd: directory,
      env: { ...process.env, PATH: directory },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const guard = setTimeout(() => child.kill("SIGKILL"), 7000);
    try {
      const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
      expect(code).toBe(0);
      expect(stderr).toContain("recovered worker survived");
      expect(stderr).not.toContain("a synchronous call that never returns");
    } finally {
      clearTimeout(guard);
      child.kill("SIGKILL");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a reporter exits cleanly when its target already died", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watchdog-dead-target-"));
  try {
    const target = Bun.spawn(["/bin/sh", "-c", "exit 0"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    await target.exited;
    const report = { pid: target.pid, deadline: Date.now() + 100, header: "dead target report\n" };
    const reporter = Bun.spawn(
      [process.execPath, join(import.meta.dir, "watchdog-thread.ts"), JSON.stringify(report)],
      {
        env: { ...process.env, PATH: directory },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const guard = setTimeout(() => reporter.kill("SIGKILL"), 3000);
    try {
      const [stderr, code] = await Promise.all([
        new Response(reporter.stderr).text(),
        reporter.exited,
      ]);
      expect(code).toBe(0);
      expect(stderr).toContain("dead target report");
      expect(stderr).toContain("Native stack unavailable: no sampling tool exists");
      expect(stderr).not.toContain("ESRCH");
    } finally {
      clearTimeout(guard);
      reporter.kill("SIGKILL");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
