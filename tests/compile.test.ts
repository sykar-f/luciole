import { expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileClient, hostTarget, runtimePortability } from "../packages/core/src/compile";
import { messageOf } from "../packages/core/src/guards";
import {
  BUILD_TEST_MS,
  execute,
  exited,
  launch,
  privateBuild,
  rejectionOf,
  until,
  WAIT_MS,
} from "./helpers";

const built = await privateBuild("examples/notes");

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
  const { output, buildId } = built;
  const work = await mkdtemp(join(tmpdir(), "luciole-compile-"));
  const server = await launch(join(built.output, "server/index.js"), {
    NOTES_DB: join(work, "notes.sqlite"),
  });
  let client: Subprocess | undefined, run: string | undefined;
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
      const details = await execute([
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
    run = await mkdtemp(join(tmpdir(), "luciole-run-"));
    await copyFile(outfile, join(run, "client"));
    const log = join(run, "screen.log");
    client = Bun.spawn(inPty(log, `./client --url ${server.url}`), {
      cwd: run,
      env: { HOME: run, TERM: "xterm-256color", PATH: "/usr/bin:/bin" },
      stdout: "ignore",
      stderr: "ignore",
    });
    let screen = "";
    const shown = () => {
      screen = existsSync(log) ? Bun.stripANSI(readFileSync(log, "utf8")) : "";
      return ["Welcome to Notes", "+ New note", "No note selected"].every((text) =>
        screen.includes(text),
      );
    };
    await until(shown, WAIT_MS, () => screen);
    await Bun.write(join(run, "stop"), "");
    // Ctrl+C: the Client quits on purpose, before its Server stops.
    await exited(client);
    // The list only exists once the Server answered (the renderer redraws changed cells
    // only, so a status is not captured as one word).
    expect(screen).toContain("+ New note");
    expect(screen).toContain("No note selected");
    expect(screen).toContain("Welcome to Notes");
    // The build identity travels inside the binary.
    expect(await Bun.file(outfile).text()).toContain(buildId);
  } finally {
    // After a failed step too, the Client quits before its Server stops under its calls.
    if (client && run) {
      await Bun.write(join(run, "stop"), "");
      await exited(client).catch(() => {});
    }
    await server.stop();
    if (run) await rm(run, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
}, 60000);

test("unsupported targets and missing native packages are explained", async () => {
  const { output } = built;
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

// Only where the Bun running the tests links libraries other Macs lack (Nix, Homebrew).
const portability = await runtimePortability(process.execPath);
test.if(portability !== undefined)(
  "--portable refuses a runtime other machines could not start, before compiling",
  async () => {
    const { output } = built;
    const outfile = join(tmpdir(), "luciole-never-portable");
    const refused = await rejectionOf(
      compileClient(output, { name: "notes", outfile, runtime: "host", portable: true }),
    );
    expect(messageOf(refused)).toContain("may not start on other Macs");
    expect(await Bun.file(outfile).exists()).toBe(false);
  },
  60000,
);

test(
  "signing is only accepted where it can succeed",
  async () => {
    const { output } = built;
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
  },
  BUILD_TEST_MS,
);

test("a publishing flag without its value is refused before any build", async () => {
  const cli = (...flags: string[]) =>
    execute([process.execPath, "packages/core/src/cli.ts", "build", "--compile", ...flags]);
  // Last on the line, or followed by another flag: both used to mean "not requested".
  for (const flags of [
    ["--sign", "Developer ID Application: Acme", "--notarize"],
    ["--notarize", "--sign", "Developer ID Application: Acme"],
  ]) {
    const run = await cli(...flags);
    expect(run.exitCode).toBe(2);
    expect(run.stderr.toString()).toContain("--notarize needs a value");
    expect(run.stdout.toString()).not.toContain("buildId");
  }
});
