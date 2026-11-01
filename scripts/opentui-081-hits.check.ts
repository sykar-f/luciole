/** Selected proof of the inactive 0.8.1 pixel-scroll port. Run via orch test run.
 * Keeps the upstream checkout and logs under TMPDIR for mission cleanup.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "opentui-081-hits-"));
const checkout = join(scratch, "opentui");
const native = join(checkout, "packages/native");
const core = join(checkout, "packages/core");
const simulation = "src/tests/native-session.sim.test.ts";
const typeScriptEnv = { OTUI_TREE_SITTER_WORKER_PATH: join(core, "dist/parser.worker.js") };
const zig = process.env["ZIG"] ?? "zig";
// Debug native tests include allocator stack traces and can take several minutes.
const TIMEOUT_MS = 1_800_000;
const CLEANUP_MS = 5_000;
const MIN_SELECTED_FILES = 45;
const upstream = "9a09079c0c7ad0fb2d55404f66a5c453204328dd";
const spike = "a64f24c75b98c76a75064e02fc8c45916cde487d";
let prepared = false;
let libraryReady = false;

function stopGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

async function run(
  command: string[],
  cwd = checkout,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<void> {
  console.log(`0.8.1 check [${cwd}]: ${command.join(" ")}`);
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, ...extraEnv, PATH: `${dirname(zig)}:${process.env["PATH"] ?? ""}` },
    stdout: "inherit",
    stderr: "inherit",
    detached: true,
    signal: AbortSignal.timeout(TIMEOUT_MS - CLEANUP_MS),
  });
  try {
    expect(await child.exited).toBe(0);
  } finally {
    stopGroup(child.pid);
  }
}

test(
  "0.8.1 pixel scroll: clean patch stack and generated ABI",
  async () => {
    console.log(`0.8.1 check checkout: ${checkout}`);
    await run(
      [
        "git",
        "clone",
        "--depth",
        "1",
        "--branch",
        "v0.8.1",
        "https://github.com/anomalyco/opentui",
        checkout,
      ],
      root,
    );
    const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: checkout });
    expect(head.exitCode).toBe(0);
    expect(head.stdout.toString().trim()).toBe(upstream);
    // The web port lands independently. Until then, use its exact spike baseline.
    const web = join(root, "packages/core/web/opentui-v0.8.1.patch");
    let webBytes: Uint8Array;
    if (existsSync(web)) webBytes = readFileSync(web);
    else {
      const source = Bun.spawnSync(
        ["git", "show", `${spike}:spikes/opentui-08/opentui-v0.8.1-web.patch`],
        { cwd: root },
      );
      expect(source.exitCode).toBe(0);
      webBytes = source.stdout;
    }
    const webPatch = join(scratch, "web.patch");
    await Bun.write(webPatch, webBytes);
    for (const patch of [
      webPatch,
      join(root, "packages/core/web/opentui-v0.8.1-pixel-scroll.patch"),
    ]) {
      await run(["git", "apply", "--check", patch]);
      await run(["git", "apply", patch]);
    }
    await run([process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"]);
    await run([process.execPath, "run", "prepare:zig"], native);
    await run([process.execPath, "packages/core/scripts/native-abi.ts", "--check"]);
    prepared = true;
  },
  TIMEOUT_MS,
);

test(
  "0.8.1 pixel scroll: native tests, C ABI and upstream release library",
  async () => {
    expect(prepared).toBe(true);
    await run([zig, "build", "test", "-Drequire-video", "--summary", "all"], native);
    await run([zig, "build", "test-abi", "-Drequire-video", "--summary", "all"], native);
    // CI downloads the release library: build-core.yml -> native-bottle.ts ->
    // core/scripts/build.ts defaults to ReleaseFast. Native unit tests above
    // retain their upstream default Debug mode.
    await run([zig, "build", "-Doptimize=ReleaseFast", "-Drequire-video"], native);
    await run(
      [process.execPath, "scripts/build.ts", "--native", "--skip-zig", "--skip-symbols"],
      core,
    );
    await run([process.execPath, "run", "build:lib"], core);
    libraryReady = true;
  },
  TIMEOUT_MS,
);

test(
  "0.8.1 pixel scroll: scene, renderer, NativeSession and pixel TypeScript tests",
  async () => {
    expect(libraryReady).toBe(true);
    const discovered: string[] = [];
    for await (const file of new Bun.Glob("packages/core/**/*.test.ts").scan({
      cwd: checkout,
      onlyFiles: true,
    }))
      discovered.push(file);
    const files: string[] = [];
    for (const file of discovered.sort()) {
      const named =
        /\/(?:renderer\.[^/]+|native-session(?:\.sim)?|native-detached-session|native-scene-buffer|scene-observation-cache|pixel-seams|Timeline\.renderer|test-renderer\.wait|native-abi)\.test\.ts$/.test(
          file,
        );
      const caller =
        /NativeSession|CliRenderer|nativeScene|NativeScene|createTestRenderer|translateX|translateY|ScrollBox|ScrollableViewport|scrollOnce|wheelDirection|scrollByWheel|scrollableViewport/.test(
          await Bun.file(join(checkout, file)).text(),
        );
      if (named || caller) files.push(file.slice("packages/core/".length));
    }
    expect(files.length).toBeGreaterThan(MIN_SELECTED_FILES);
    expect(files).toContain(simulation);
    // Match core/package.json test:js: run from Core, with its bunfig.toml
    // preload and Bun's default per-test timeout (5000 ms; bun test --help).
    // That preload wakes Bun's setImmediate poll every 10 ms. CI also points
    // tree-sitter at the built parser worker (build-core.yml).
    await run(
      [process.execPath, "test", ...files.filter((file) => file !== simulation)],
      core,
      typeScriptEnv,
    );
  },
  TIMEOUT_MS,
);

// The only selected file defining a live simulate() loop owns process.stdout
// and render-lib mocks. Keep it in a separate process per mission question 2;
// upstream's test:js runs it with the same Core preload/default timeout.
test(
  "0.8.1 pixel scroll: isolated upstream NativeSession simulation",
  async () => {
    expect(libraryReady).toBe(true);
    await run([process.execPath, "test", simulation], core, typeScriptEnv);
  },
  TIMEOUT_MS,
);
