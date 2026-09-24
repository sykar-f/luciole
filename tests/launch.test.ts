import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { leaveCrashedSession } from "./helpers";

const cli = resolve("src/cli.ts");

// macOS and util-linux spell script(1) differently; see tests/compile.test.ts.
const inPty = (log: string, command: string) => {
  const script =
    process.platform === "darwin"
      ? `/usr/bin/script -q ${log} ${command}`
      : `script -q -e -f -c '${command}' ${log}`;
  return ["/bin/sh", "-c", `(while [ ! -f stop ]; do sleep 0.1; done; printf '\\003') | ${script}`];
};

test("`airtty ./app` builds it, runs its Server on a socket and its Client here", async () => {
  const temporary = await mkdtemp("/tmp/airtty-t-");
  const run = await mkdtemp(join(tmpdir(), "airtty-launch-"));
  try {
    // A Client of this app crashed on a note: the new launch, on another socket, reopens it.
    await leaveCrashedSession(
      join(run, "state"),
      "notes",
      `local:${resolve("examples/notes")}`,
      "/notes/1",
    );
    const log = join(run, "screen.log");
    const child = Bun.spawn(inPty(log, `${process.execPath} ${cli} ${resolve("examples/notes")}`), {
      cwd: run,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        TMPDIR: temporary,
        XDG_RUNTIME_DIR: "",
        XDG_STATE_HOME: join(run, "state"),
        NOTES_DB: join(run, "notes.sqlite"),
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    let screen = "";
    const deadline = performance.now() + 30000;
    while (performance.now() < deadline && !screen.includes("baseline:")) {
      await Bun.sleep(100);
      screen = Bun.stripANSI(await readFile(log, "utf8").catch(() => ""));
    }
    const sockets = () => readdirSync(temporary).filter((entry) => entry.startsWith("airtty-"));
    expect(sockets()).toHaveLength(1);
    await Bun.write(join(run, "stop"), "");
    await Promise.race([child.exited, Bun.sleep(5000).then(() => child.kill())]);
    expect(screen).toContain("baseline:");
    expect(existsSync(join(run, "state/airtty/notes/server.log"))).toBe(true);
    const gone = performance.now() + 3000;
    while (sockets().length && performance.now() < gone) await Bun.sleep(50);
    expect(sockets()).toEqual([]);
  } finally {
    await rm(run, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}, 60000);

test("a launcher killed with SIGKILL still takes its Server and socket directory along", async () => {
  const work = await mkdtemp(join(tmpdir(), "airtty-kill-"));
  const script = join(work, "launcher.ts");
  await Bun.write(
    script,
    `import { startServer } from ${JSON.stringify(resolve("src/launcher/local.ts"))};
const server = await startServer({
  name: "instrumented",
  directories: { state: ${JSON.stringify(join(work, "state"))} },
  command: () => [process.execPath, "--conditions=react-server", ${JSON.stringify(resolve("src/launcher/serve.ts"))}, ${JSON.stringify(resolve("tests/instrument-server.ts"))}, "--attached"],
});
console.log(server.url);
setInterval(() => {}, 1000);`,
  );
  const launcher = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "inherit" });
  try {
    const reader = launcher.stdout.getReader();
    let url = "";
    while (!url.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("The launcher exited");
      url += new TextDecoder().decode(value);
    }
    const socket = url.trim().slice("unix:".length);
    expect(existsSync(socket)).toBe(true);
    launcher.kill("SIGKILL");
    await launcher.exited;
    const deadline = performance.now() + 5000;
    while (existsSync(join(socket, "..")) && performance.now() < deadline) await Bun.sleep(50);
    expect(existsSync(join(socket, ".."))).toBe(false);
  } finally {
    launcher.kill("SIGKILL");
    await rm(work, { recursive: true, force: true });
  }
});

test("the CLI explains what it cannot launch", () => {
  const airtty = (...args: string[]) => {
    const result = Bun.spawnSync([process.execPath, cli, ...args]);
    return { code: result.exitCode, stderr: result.stderr.toString() };
  };
  expect(airtty("https://notes.example.com")).toMatchObject({ code: 1 });
  expect(airtty("https://notes.example.com").stderr).toContain("not supported yet");
  expect(airtty("./no-such-app").stderr).toContain("is not an airtty app");
  expect(airtty("examples/notes").stderr).toContain("start it with ./");
  expect(airtty("--nope").stderr).toContain("Usage: airtty");
  expect(airtty("./examples/notes", "--on", "host").stderr).toContain("airtty build --compile");
});
