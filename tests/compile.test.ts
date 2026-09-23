import { expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../src/build";
import { compileClient, hostTarget } from "../src/compile";
import { messageOf } from "../src/guards";
import { launch, rejectionOf } from "./helpers";

const root = resolve("examples/notes");

// macOS and util-linux spell script(1) differently (busybox lacks -e); util-linux must
// flush the log the test reads while the Client runs. Its input must be a real pipe (not
// a socket): a shell pipe that sends Ctrl+C once the test creates the `stop` file.
const inPty = (log: string, command: string) => {
  const script =
    process.platform === "darwin"
      ? `/usr/bin/script -q ${log} ${command}`
      : `script -q -e -f -c '${command}' ${log}`;
  return ["/bin/sh", "-c", `(while [ ! -f stop ]; do sleep 0.1; done; printf '\\003') | ${script}`];
};

test("the compiled Client runs alone: no Bun, no node_modules, same build as its Server", async () => {
  const { output, buildId } = await build(root);
  const work = await mkdtemp(join(tmpdir(), "airtty-compile-"));
  const server = await launch(join(root, ".airtty/server/index.js"), {
    NOTES_DB: join(work, "notes.sqlite"),
  });
  try {
    const { outfile, target } = await compileClient(output, {
      name: "notes",
      outfile: join(work, "build/notes-client"),
      // The stock runtime is covered by runtime.test.ts; this test stays offline.
      runtime: "host",
      // Ad hoc, but with the hardened runtime and entitlements of a Developer ID signature.
      sign: process.platform === "darwin" ? "-" : undefined,
    });
    expect<string>(target).toBe(hostTarget());
    if (process.platform === "darwin") {
      const details = Bun.spawnSync([
        "codesign",
        "-d",
        "--verbose=2",
        "--entitlements",
        "-",
        outfile,
      ]);
      const text = details.stdout.toString() + details.stderr.toString();
      expect(text).toMatch(/flags=0x\w+\(adhoc,runtime\)/);
      expect(text).toContain("com.apple.security.cs.allow-jit");
      expect(text).toContain("com.apple.security.cs.disable-library-validation");
    }
    // An empty directory, far from any node_modules, with a minimal environment.
    const run = await mkdtemp(join(tmpdir(), "airtty-run-"));
    await copyFile(outfile, join(run, "client"));
    const log = join(run, "screen.log");
    const client = Bun.spawn(inPty(log, `./client --url ${server.url}`), {
      cwd: run,
      env: { HOME: run, TERM: "xterm-256color", PATH: "/usr/bin:/bin" },
      stdout: "ignore",
      stderr: "ignore",
    });
    let screen = "";
    const deadline = performance.now() + 15000;
    while (performance.now() < deadline && !screen.includes("First note")) {
      await Bun.sleep(100);
      screen = Bun.stripANSI(await readFile(log, "utf8").catch(() => ""));
    }
    await Bun.write(join(run, "stop"), "");
    await Promise.race([client.exited, Bun.sleep(3000).then(() => client.kill())]);
    // The list only exists once the Server answered (the renderer redraws changed cells
    // only, so the heading's status is not captured as one word).
    expect(screen).toContain("TERMINAL / NOTES");
    expect(screen).toContain("YOUR NOTES");
    expect(screen).toContain("First note");
    // The build identity travels inside the binary.
    expect(await Bun.file(outfile).text()).toContain(buildId);
    await rm(run, { recursive: true, force: true });
  } finally {
    await server.stop();
    await rm(work, { recursive: true, force: true });
  }
}, 60000);

test("unsupported targets and missing native packages are explained", async () => {
  const { output } = await build(root);
  expect(
    messageOf(
      await rejectionOf(compileClient(output, { name: "notes", target: "bun-windows-x64" })),
    ),
  ).toContain("Unsupported target bun-windows-x64");
  const foreign = hostTarget() === "bun-linux-arm64" ? "bun-darwin-arm64" : "bun-linux-arm64";
  const missing = await rejectionOf(
    compileClient(output, {
      name: "notes",
      target: foreign,
      outfile: join(tmpdir(), "never"),
      runtime: process.execPath,
    }),
  );
  expect(messageOf(missing)).toContain("--native-dir");
}, 60000);

test("signing is only accepted where it can succeed", async () => {
  const { output } = await build(root);
  const compile = (options: Parameters<typeof compileClient>[1]) =>
    compileClient(output, { outfile: join(tmpdir(), "never"), ...options });
  const refused = async (options: Parameters<typeof compileClient>[1]) =>
    messageOf(await rejectionOf(compile(options)));
  expect(await refused({ name: "notes", target: "bun-linux-x64", sign: "-" })).toContain(
    "apply to macOS targets",
  );
  if (process.platform !== "darwin") return;
  expect(await refused({ name: "notes", notarize: "profile" })).toContain(
    "--notarize needs --sign",
  );
  expect(await refused({ name: "notes", sign: "-", notarize: "profile" })).toContain(
    "does not notarize ad hoc signatures",
  );
});

test("a publishing flag without its value is refused before any build", () => {
  const cli = (...flags: string[]) =>
    Bun.spawnSync([process.execPath, "src/cli.ts", "build", "--compile", ...flags], {
      stdout: "pipe",
      stderr: "pipe",
    });
  // Last on the line, or followed by another flag: both used to mean "not requested".
  for (const flags of [
    ["--sign", "Developer ID Application: Acme", "--notarize"],
    ["--notarize", "--sign", "Developer ID Application: Acme"],
  ]) {
    const run = cli(...flags);
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toContain("--notarize needs a value");
    expect(run.stdout.toString()).not.toContain("buildId");
  }
});
