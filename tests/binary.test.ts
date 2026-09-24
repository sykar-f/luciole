import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { build } from "../src/build";
import { compileApp, hostTarget } from "../src/compile";
import { connect, socketDirectory } from "../src/connect";
import { messageOf } from "../src/guards";
import { readBinaryIdentity, type BinaryIdentity } from "../src/launcher/identity";
import { runOn } from "../src/launcher/remote";
import { rejectionOf } from "./helpers";

const root = resolve("examples/notes");
let work: string, binary: string, identity: BinaryIdentity;

// Stands for OpenSSH on a host that is this machine with its own HOME: runs the remote
// command with sh (in a directory of its own: two Notes Servers cannot share one
// database), forwards -L local:remote sockets, and treats the master connection (-M)
// and its control commands (-O) as done.
const FAKE_SSH = `
import { appendFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { connect, createServer } from "node:net";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(args) + "\\n");
if (args.includes("-M") || args.includes("-O")) process.exit(0);
let i = 0, forward;
for (; i < args.length && args[i] !== "--"; i++) {
  if (args[i] === "-L") forward = args[++i];
  else if (args[i] === "-o" || args[i] === "-p") i++;
}
const command = args.slice(i + 2).join(" ");
if (forward) {
  const at = forward.indexOf(":");
  createServer((client) => {
    const upstream = connect({ path: forward.slice(at + 1) });
    client.pipe(upstream).pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  }).listen(forward.slice(0, at));
}
const home = process.env.FAKE_REMOTE_HOME;
const child = spawn("/bin/sh", ["-c", command], {
  stdio: "inherit",
  cwd: mkdtempSync(join(home, "session-")),
  env: { PATH: process.env.PATH, HOME: home },
});
child.on("exit", (code) => process.exit(code ?? 1));
`;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "airtty-binary-"));
  const { output } = await build(root);
  const compiled = await compileApp(output, {
    name: "notes",
    outfile: join(work, "notes"),
    // The stock runtime is covered by runtime.test.ts; this test stays offline.
    runtime: "host",
  });
  binary = compiled.outfile;
  identity = compiled.identity;
  await Bun.write(join(work, "ssh"), `#!${process.execPath}\n${FAKE_SSH}`);
  await chmod(join(work, "ssh"), 0o755);
}, 120000);
afterAll(() => rm(work, { recursive: true, force: true }));

test("an app binary carries its identity, readable without running it", async () => {
  expect(identity).toEqual({ name: "notes", buildId: identity.buildId, target: hostTarget() });
  expect(await readBinaryIdentity(binary)).toEqual(identity);
  const printed = Bun.spawnSync([binary, "--version"]).stdout.toString();
  expect(JSON.parse(printed)).toMatchObject(identity);
  expect(messageOf(await rejectionOf(readBinaryIdentity(join(root, "app/page.tsx"))))).toContain(
    "is not an airtty app binary",
  );
});

const Ready = z.object({ ready: z.literal(true), socket: z.string(), buildId: z.string() });

test("`notes serve --socket` is the Server alone, on a private socket", async () => {
  const socket = join(socketDirectory("airtty-serve-"), "s");
  const server = spawn(binary, ["serve", "--socket", socket], {
    cwd: work,
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    const ready = await new Promise<z.infer<typeof Ready>>((done, fail) => {
      server.once("exit", () => fail(new Error("Server exited")));
      createInterface({ input: server.stdout }).on("line", (line) => {
        const parsed = Ready.safeParse(JSON.parse(line));
        if (parsed.success) done(parsed.data);
      });
    });
    expect(ready).toMatchObject({ socket, buildId: identity.buildId });
    const connection = await connect(`unix:${socket}`);
    const health = await connection.fetch?.(new URL("/health", connection.url), {});
    expect(await health?.json()).toMatchObject({ buildId: identity.buildId });
  } finally {
    server.kill();
    await rm(join(socket, ".."), { recursive: true, force: true });
  }
  expect(
    Bun.spawnSync([binary, "serve", "--http", ":1", "--socket", "/x"]).stderr.toString(),
  ).toContain("exclusive");
});

// macOS and util-linux spell script(1) differently; see tests/compile.test.ts.
const inPty = (log: string, command: string) => {
  const script =
    process.platform === "darwin"
      ? `/usr/bin/script -q ${log} ${command}`
      : `script -q -e -f -c '${command}' ${log}`;
  return ["/bin/sh", "-c", `(while [ ! -f stop ]; do sleep 0.1; done; printf '\\003') | ${script}`];
};

test("`notes` alone runs both roles here, and its Server ends with the Client", async () => {
  // A short TMPDIR, cleaned by this test: the launcher's socket directories go there.
  const temporary = await mkdtemp("/tmp/airtty-t-");
  const run = await mkdtemp(join(tmpdir(), "airtty-local-"));
  try {
    await copyFile(binary, join(run, "notes"));
    const log = join(run, "screen.log");
    const client = Bun.spawn(inPty(log, "./notes"), {
      cwd: run,
      env: { HOME: run, TERM: "xterm-256color", PATH: "/usr/bin:/bin", TMPDIR: temporary },
      stdout: "ignore",
      stderr: "ignore",
    });
    let screen = "";
    const deadline = performance.now() + 15000;
    while (performance.now() < deadline && !screen.includes("First note")) {
      await Bun.sleep(100);
      screen = Bun.stripANSI(await readFile(log, "utf8").catch(() => ""));
    }
    // Listening now: one private socket directory, no TCP port. (Bun also extracts
    // OpenTUI's native library there.)
    const sockets = () => readdirSync(temporary).filter((entry) => entry.startsWith("airtty-"));
    expect(sockets()).toHaveLength(1);
    await Bun.write(join(run, "stop"), "");
    await Promise.race([client.exited, Bun.sleep(5000).then(() => client.kill())]);
    expect(screen).toContain("First note");
    // The Server's data lives where the user ran it; its log in their state directory.
    expect(existsSync(join(run, "notes.sqlite"))).toBe(true);
    expect(existsSync(join(run, ".local/state/airtty/notes/server.log"))).toBe(true);
    const deadlineGone = performance.now() + 3000;
    while (sockets().length && performance.now() < deadlineGone) await Bun.sleep(50);
    expect(sockets()).toEqual([]);
  } finally {
    await rm(run, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}, 60000);

async function sshCalls(file: string) {
  const text = await Bun.file(file)
    .text()
    .catch(() => "");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => z.array(z.string()).parse(JSON.parse(line)));
}

test("--on installs the binary once on the host, then serves through ssh", async () => {
  const remoteHome = await mkdtemp(join(tmpdir(), "airtty-remote-"));
  const state = await mkdtemp(join(tmpdir(), "airtty-state-"));
  const log = join(remoteHome, "ssh.jsonl");
  const env = {
    ...process.env,
    AIRTTY_SSH: join(work, "ssh"),
    FAKE_SSH_LOG: log,
    FAKE_REMOTE_HOME: remoteHome,
  };
  const messages: string[] = [];
  const options = {
    identity,
    self: binary,
    directories: { state },
    log: (message: string) => messages.push(message),
    env,
  };
  const installed = join(remoteHome, `.local/share/airtty/apps/notes/${identity.buildId}/notes`);
  try {
    // Two launches at once: one uploads, the other waits for it.
    const servers = await Promise.all([
      runOn("alice@host.example", options),
      runOn("host.example:2222", options),
    ]);
    expect(existsSync(installed)).toBe(true);
    expect(await readBinaryIdentity(installed)).toEqual(identity);
    for (const server of servers) {
      const connection = await connect(server.url);
      const health = await connection.fetch?.(new URL("/health", connection.url), {});
      expect(await health?.json()).toMatchObject({ buildId: identity.buildId });
    }
    const calls = await sshCalls(log);
    expect(calls.some((args) => args.includes("-p") && args.includes("2222"))).toBe(true);
    expect(calls.some((args) => args.includes("alice@host.example"))).toBe(true);
    await Promise.all(servers.map((server) => server.stop()));
    // Installed: the next launch uploads nothing.
    messages.length = 0;
    const again = await runOn("host.example", options);
    expect(messages).toEqual([]);
    await again.stop();
    // The remote Server and its socket directory are gone with the tunnel.
    const deadline = performance.now() + 5000;
    const leftovers = () =>
      readdirSync("/tmp").filter((entry) => /^airtty-[0-9a-f]{16}$/.test(entry)).length;
    while (leftovers() && performance.now() < deadline) await Bun.sleep(50);
    expect(leftovers()).toBe(0);
  } finally {
    await rm(remoteHome, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
}, 60000);

test("--on a host of another platform needs a binary of the same build for it", async () => {
  const remoteHome = await mkdtemp(join(tmpdir(), "airtty-remote-"));
  const env = {
    ...process.env,
    AIRTTY_SSH: join(work, "ssh"),
    FAKE_SSH_LOG: join(remoteHome, "ssh.jsonl"),
    FAKE_REMOTE_HOME: remoteHome,
  };
  const options = {
    identity: { ...identity, target: "bun-linux-riscv" },
    self: binary,
    directories: { state: remoteHome },
    log: () => {},
    env,
  };
  try {
    expect(messageOf(await rejectionOf(runOn("host.example", options)))).toContain(
      `pass --target <notes binary built for ${hostTarget()}>`,
    );
    // Another app's binary, or another build's, is refused before any upload.
    const other = join(remoteHome, "other");
    await mkdir(join(remoteHome, "x"));
    await Bun.write(other, `airtty-binary:1:notes:0000:${hostTarget()};`);
    expect(
      messageOf(await rejectionOf(runOn("host.example", { ...options, target: other }))),
    ).toContain(`needs notes ${identity.buildId}`);
    expect(existsSync(join(remoteHome, ".local/share/airtty/apps/notes"))).toBe(false);
    expect(messageOf(await rejectionOf(runOn("-oProxyCommand=x", options)))).toContain(
      'cannot start with "-"',
    );
  } finally {
    await rm(remoteHome, { recursive: true, force: true });
  }
}, 60000);
