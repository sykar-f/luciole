import { expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../src/build";
import { compileClient, hostTarget } from "../src/compile";
import { launch } from "./helpers";

const root = resolve("examples/notes");

// macOS and util-linux spell script(1) differently. Its input must be a real pipe (not
// a socket): a shell pipe that sends Ctrl+C once the test creates the `stop` file.
const inPty = (log: string, command: string) => {
  const script =
    process.platform === "darwin"
      ? `/usr/bin/script -q ${log} ${command}`
      : `script -q -e -c '${command}' ${log}`;
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
    });
    expect<string>(target).toBe(hostTarget());
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
  await expect(compileClient(output, { name: "notes", target: "bun-windows-x64" })).rejects.toThrow(
    "Unsupported target bun-windows-x64",
  );
  const foreign = hostTarget() === "bun-linux-arm64" ? "bun-darwin-arm64" : "bun-linux-arm64";
  await expect(
    compileClient(output, {
      name: "notes",
      target: foreign,
      outfile: join(tmpdir(), "never"),
      runtime: process.execPath,
    }),
  ).rejects.toThrow("--native-dir");
}, 60000);
