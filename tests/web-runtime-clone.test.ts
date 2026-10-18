import { expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TREE_SITTER_DIRECTORY, WEB_RUNTIME_FILES } from "../packages/core/src/web/build";
import {
  openTuiCheckoutDirectory,
  prepareOpenTuiCheckout,
  prepareWebRuntimeEntry,
  prepareWebRuntime,
  webRuntimeDirectory,
} from "../packages/core/src/web-runtime";

async function fixture(
  run: (source: string, checkout: string, directory: string) => void | Promise<void>,
) {
  const directory = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "web-runtime-clone-"));
  const source = join(directory, "source");
  const checkout = join(directory, "checkout");
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: source, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  try {
    mkdirSync(source);
    git("init", "--quiet");
    writeFileSync(join(source, "tracked.txt"), "original\n");
    git("add", ".");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    );
    git("tag", "fixture");
    await run(source, checkout, directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("replaces a poisoned checkout whose .git has no HEAD", async () => {
  await fixture((source, checkout) => {
    mkdirSync(join(checkout, ".git"), { recursive: true });
    writeFileSync(join(checkout, "interrupted"), "partial clone");
    prepareOpenTuiCheckout(checkout, source, "fixture");
    expect(readFileSync(join(checkout, "tracked.txt"), "utf8")).toBe("original\n");
    expect(existsSync(join(checkout, "interrupted"))).toBe(false);
  });
});

test("replaces a checkout with HEAD but missing tracked files", async () => {
  await fixture((source, checkout) => {
    prepareOpenTuiCheckout(checkout, source, "fixture");
    rmSync(join(checkout, "tracked.txt"));
    prepareOpenTuiCheckout(checkout, source, "fixture");
    expect(readFileSync(join(checkout, "tracked.txt"), "utf8")).toBe("original\n");
  });
});

test("reuses complete checkouts and preserves applied patches", async () => {
  await fixture((source, checkout) => {
    prepareOpenTuiCheckout(checkout, source, "fixture");
    writeFileSync(join(checkout, "tracked.txt"), "patched\n");
    prepareOpenTuiCheckout(checkout, join(source, "unavailable"), "fixture");
    expect(readFileSync(join(checkout, "tracked.txt"), "utf8")).toBe("patched\n");
  });
});

test("a failed git clone removes its temporary directory and leaves no final checkout", async () => {
  await fixture((source, checkout, directory) => {
    expect(() => prepareOpenTuiCheckout(checkout, source, "missing-tag")).toThrow();
    expect(existsSync(checkout)).toBe(false);
    expect(readdirSync(directory)).toEqual(["source"]);
  });
});

test("a clone interrupted after writing files never publishes a checkout", async () => {
  await fixture((source, checkout, directory) => {
    const spawn = Bun.spawnSync;
    // Clone real local sources, then simulate a failure after git wrote its files.
    const interrupted: typeof spawn = (command) => {
      if (!Array.isArray(command)) throw new Error("Expected a command array");
      const result = spawn(command);
      if (command[1] === "clone") {
        expect(existsSync(checkout)).toBe(false);
        throw new Error("interrupted clone");
      }
      return result;
    };
    const clone = spyOn(Bun, "spawnSync").mockImplementation(interrupted);
    try {
      expect(() => prepareOpenTuiCheckout(checkout, source, "fixture")).toThrow(
        "interrupted clone",
      );
    } finally {
      clone.mockRestore();
    }
    expect(existsSync(checkout)).toBe(false);
    expect(readdirSync(directory)).toEqual(["source"]);
    prepareOpenTuiCheckout(checkout, source, "fixture");
    expect(readFileSync(join(checkout, "tracked.txt"), "utf8")).toBe("original\n");
  });
});

function writeRuntime(directory: string, text: string) {
  mkdirSync(join(directory, TREE_SITTER_DIRECTORY), { recursive: true });
  for (const name of [...WEB_RUNTIME_FILES, "runtime.js.map", "web-runtime.json"])
    writeFileSync(join(directory, name), text);
}

async function workerFixture(directory: string) {
  const worker = join(directory, "worker.ts");
  await Bun.write(
    worker,
    `
import { mkdirSync, rmSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareOpenTuiCheckout, prepareWebRuntimeEntry } from ${JSON.stringify(
      join(import.meta.dir, "../packages/core/src/web-runtime.ts"),
    )};
const [directory, source, role] = Bun.argv.slice(2);
const release = Promise.withResolvers();
process.on("message", (message) => { if (message === "release") release.resolve(); });
const result = await prepareWebRuntimeEntry({
  directory: join(directory, "runtime"),
  checkout: join(directory, "checkout"),
  waiting() { process.send("waiting"); },
  async build(temporary) {
    prepareOpenTuiCheckout(join(directory, "checkout"), source, "fixture");
    // mkdir fails if a second preparer enters the shared checkout concurrently.
    const busy = join(directory, "preparing");
    mkdirSync(busy);
    try {
      appendFileSync(join(directory, "builds"), role + "\\n");
      process.send("entered");
      if (role === "first") await release.promise;
      mkdirSync(join(temporary, "tree-sitter"));
      for (const name of ${JSON.stringify([...WEB_RUNTIME_FILES, "runtime.js.map", "web-runtime.json"])})
        writeFileSync(join(temporary, name), role);
    } finally {
      rmSync(busy, { recursive: true, force: true });
    }
  },
});
process.send("done:" + result);
process.disconnect();
`,
  );
  return (source: string, role: string) => {
    const events = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
    const event = (name: string) => {
      let signal = events.get(name);
      if (!signal) {
        signal = Promise.withResolvers<void>();
        events.set(name, signal);
      }
      return signal;
    };
    const child = Bun.spawn([process.execPath, worker, directory, source, role], {
      stdout: "ignore",
      stderr: "pipe",
      ipc(message) {
        if (typeof message === "string") event(message).resolve();
      },
    });
    return {
      child,
      wait(name: string) {
        return Promise.race([
          event(name).promise,
          child.exited.then(async (code) => {
            throw new Error(
              `Worker exited (${code}) before ${name}: ${await new Response(child.stderr).text()}`,
            );
          }),
        ]);
      },
    };
  };
}

test("two processes serialize one checkout and return the same complete runtime", async () => {
  await fixture(async (source, checkout, directory) => {
    const start = await workerFixture(directory);
    const first = start(source, "first");
    let second: ReturnType<typeof start> | undefined;
    const runtime = join(directory, "runtime");
    try {
      await first.wait("entered");
      second = start(source, "second");
      // IPC confirms actual lock contention before letting the first build finish.
      await second.wait("waiting");
      expect(existsSync(runtime)).toBe(false);
      first.child.send("release");
      await Promise.all([first.wait(`done:${runtime}`), second.wait(`done:${runtime}`)]);
      expect(await first.child.exited).toBe(0);
      expect(await second.child.exited).toBe(0);
      expect(readFileSync(join(directory, "builds"), "utf8")).toBe("first\n");
      expect(readFileSync(join(checkout, "tracked.txt"), "utf8")).toBe("original\n");
      for (const name of WEB_RUNTIME_FILES)
        expect(readFileSync(join(runtime, name), "utf8")).toBe("first");
      expect(existsSync(join(runtime, TREE_SITTER_DIRECTORY))).toBe(true);
      expect(readdirSync(directory).some((name) => name.includes(".tmp"))).toBe(false);
    } finally {
      first.child.kill();
      second?.child.kill();
      await Promise.all([first.child.exited, second?.child.exited]);
    }
  });
});

test("a killed lock owner is recovered and only its abandoned temporaries are removed", async () => {
  await fixture(async (source, checkout, directory) => {
    const start = await workerFixture(directory);
    const owner = start(source, "first");
    const runtime = join(directory, "runtime");
    let recovery: ReturnType<typeof start> | undefined;
    try {
      await owner.wait("entered");
      const abandonedClone = `${checkout}.${owner.child.pid}.tmp-abandoned`;
      const abandonedRuntime = `${runtime}.${owner.child.pid}.tmp`;
      const liveClone = `${checkout}.${process.pid}.tmp-live`;
      const unrelated = join(directory, `other.${owner.child.pid}.tmp-untouched`);
      for (const path of [abandonedClone, abandonedRuntime, liveClone, unrelated]) mkdirSync(path);
      owner.child.kill("SIGKILL");
      await owner.child.exited;
      // This sentinel belongs to the fixture's interrupted build, not to the lock.
      rmSync(join(directory, "preparing"), { recursive: true });
      recovery = start(source, "recovery");
      await recovery.wait(`done:${runtime}`);
      expect(await recovery.child.exited).toBe(0);
      expect(existsSync(abandonedClone)).toBe(false);
      expect(existsSync(abandonedRuntime)).toBe(false);
      expect(existsSync(liveClone)).toBe(true);
      expect(existsSync(unrelated)).toBe(true);
      expect(readdirSync(directory).filter((name) => /^runtime\..*\.tmp/.test(name))).toEqual([]);
      expect(readFileSync(join(runtime, "runtime.js"), "utf8")).toBe("recovery");
    } finally {
      owner.child.kill();
      recovery?.child.kill();
      await Promise.all([owner.child.exited, recovery?.child.exited]);
    }
  });
});

test("two calls in one process reuse the runtime after waiting", async () => {
  await fixture(async (_source, checkout, directory) => {
    const runtime = join(directory, "runtime");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let builds = 0;
    const first = prepareWebRuntimeEntry({
      directory: runtime,
      checkout,
      async build(temporary) {
        builds++;
        entered.resolve();
        await release.promise;
        writeRuntime(temporary, "first");
      },
    });
    await entered.promise;
    const second = prepareWebRuntimeEntry({
      directory: runtime,
      checkout,
      waiting: release.resolve,
      async build() {
        builds++;
      },
    });
    expect(await Promise.all([first, second])).toEqual([runtime, runtime]);
    expect(builds).toBe(1);
  });
});

test("accepts a complete runtime published before the final rename", async () => {
  await fixture(async (_source, checkout, directory) => {
    const runtime = join(directory, "runtime");
    const result = await prepareWebRuntimeEntry({
      directory: runtime,
      checkout,
      async build(temporary) {
        writeRuntime(temporary, "loser");
        writeRuntime(runtime, "winner");
      },
    });
    expect(result).toBe(runtime);
    expect(readFileSync(join(runtime, "runtime.js"), "utf8")).toBe("winner");
    expect(readdirSync(directory).some((name) => name.includes(".tmp"))).toBe(false);
  });
});

test("failed preparation releases its lock and removes temporary output", async () => {
  await fixture(async (_source, checkout, directory) => {
    const runtime = join(directory, "runtime");
    const failure = await prepareWebRuntimeEntry({
      directory: runtime,
      checkout,
      async build() {
        throw new Error("build failed");
      },
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ message: "build failed" });
    expect(existsSync(runtime)).toBe(false);
    expect(readdirSync(directory).some((name) => name.includes(".tmp"))).toBe(false);
    await prepareWebRuntimeEntry({
      directory: runtime,
      checkout,
      async build(temporary) {
        writeRuntime(temporary, "recovered");
      },
    });
    expect(readFileSync(join(runtime, "runtime.js"), "utf8")).toBe("recovered");
  });
});

test("rejects an incomplete competing publication and rebuilds on retry", async () => {
  await fixture(async (_source, checkout, directory) => {
    const runtime = join(directory, "runtime");
    const failure = await prepareWebRuntimeEntry({
      directory: runtime,
      checkout,
      async build(temporary) {
        writeRuntime(temporary, "candidate");
        writeRuntime(runtime, "incomplete");
        rmSync(join(runtime, "opentui.wasm"));
      },
    }).catch((error: unknown) => error);
    expect(failure).toHaveProperty("code", expect.stringMatching(/^(EEXIST|ENOTEMPTY)$/));
    expect(existsSync(join(runtime, "web-runtime.json"))).toBe(false);
    expect(readdirSync(directory).some((name) => name.includes(".tmp"))).toBe(false);
    let builds = 0;
    expect(
      await prepareWebRuntimeEntry({
        directory: runtime,
        checkout,
        async build(temporary) {
          builds++;
          writeRuntime(temporary, "recovered");
        },
      }),
    ).toBe(runtime);
    expect(builds).toBe(1);
    for (const name of [...WEB_RUNTIME_FILES, "runtime.js.map", "web-runtime.json"])
      expect(readFileSync(join(runtime, name), "utf8")).toBe("recovered");
    expect(readdirSync(directory).some((name) => name.includes(".tmp"))).toBe(false);
  });
});

test("prepareWebRuntime reports lock contention once before reusing the winner", async () => {
  await fixture(async (_source, _checkout, directory) => {
    const cache = join(directory, "cache");
    const runtime = await webRuntimeDirectory(cache);
    const checkout = openTuiCheckoutDirectory(cache);
    const release = Promise.withResolvers<void>();
    const owner = prepareWebRuntimeEntry({
      directory: runtime,
      checkout,
      async build(temporary) {
        await release.promise;
        writeRuntime(temporary, "winner");
      },
    });
    const messages: string[] = [];
    const log = spyOn(console, "error").mockImplementation((message: unknown) => {
      messages.push(String(message));
    });
    // The first retry proves actual contention and releases the holder without a sleep.
    // This also keeps a missing production waiting callback from hanging the test.
    const retry = spyOn(Bun, "sleep").mockImplementation(async () => {
      release.resolve();
    });
    try {
      const results = await Promise.all([owner, prepareWebRuntime({ cache, zig: "unused-zig" })]);
      expect(results).toEqual([runtime, runtime]);
      expect(messages).toEqual([
        `luciole web-runtime: waiting for another preparation of ${runtime}`,
      ]);
      expect(readFileSync(join(runtime, "opentui.wasm"), "utf8")).toBe("winner");
    } finally {
      release.resolve();
      retry.mockRestore();
      log.mockRestore();
      await owner;
    }
  });
});
