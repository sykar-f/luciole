import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { appendFile, chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { compileApp, hostTarget } from "../packages/core/src/compile";
import { connect, keepAlive, socketDirectory } from "../packages/core/src/connect";
import { messageOf } from "../packages/core/src/guards";
import { readBinaryIdentity, type BinaryIdentity } from "../packages/core/src/launcher/identity";
import { serverId } from "../packages/core/src/launcher/managed";
import { runOn } from "../packages/core/src/launcher/remote";
import {
  execute,
  exited,
  leaveCrashedSession,
  privateBuild,
  rejectionOf,
  until,
  WAIT_MS,
} from "./helpers";

const root = resolve("examples/notes");
const built = await privateBuild("examples/notes");
let work: string, binary: string, identity: BinaryIdentity;

// Stands for OpenSSH on a host that is this machine with its own HOME and runtime
// directory: runs the remote command with sh (in a directory of its own: two Notes
// Servers cannot share one database), forwards -L local:remote sockets (-N: nothing
// else, until killed, like a tunnel), and treats the master connection (-M) and its
// control commands (-O) as done. Each call is logged with its pid.
const FAKE_SSH = `
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { connect, createServer } from "node:net";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ pid: process.pid, args }) + "\\n");
if (args.includes("-M") || args.includes("-O")) process.exit(0);
let i = 0, forward;
for (; i < args.length && args[i] !== "--"; i++) {
  if (args[i] === "-L") forward = args[++i];
  else if (args[i] === "-o" || args[i] === "-p") i++;
}
const command = args.slice(i + 2).join(" ");
if (forward) {
  const at = forward.indexOf(":");
  // StreamLocalBindUnlink=yes: a socket left by a previous tunnel is replaced.
  rmSync(forward.slice(0, at), { force: true });
  createServer((client) => {
    const upstream = connect({ path: forward.slice(at + 1) });
    client.pipe(upstream).pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  }).listen(forward.slice(0, at));
}
if (!command) setInterval(() => {}, 1000);
else {
  const home = process.env.FAKE_REMOTE_HOME;
  const child = spawn("/bin/sh", ["-c", command], {
    stdio: "inherit",
    cwd: mkdtempSync(join(home, "session-")),
    env: { PATH: process.env.PATH, HOME: home, XDG_RUNTIME_DIR: process.env.FAKE_REMOTE_RUNTIME },
  });
  child.on("exit", (code) => process.exit(code ?? 1));
}
`;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "luciole-binary-"));
  const { output } = built;
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
  const printed = (await execute([binary, "--version"])).stdout.toString();
  expect(JSON.parse(printed)).toMatchObject(identity);
  expect(messageOf(await rejectionOf(readBinaryIdentity(join(root, "app/page.tsx"))))).toContain(
    "is not a luciole app binary",
  );
});

const Ready = z.object({ ready: z.literal(true), socket: z.string(), buildId: z.string() });

test("`notes serve --socket` is the Server alone, on a private socket", async () => {
  const socket = join(socketDirectory("luciole-serve-"), "s");
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
    (await execute([binary, "serve", "--http", ":1", "--socket", "/x"])).stderr.toString(),
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

test("`notes` alone runs both roles here; quitting on purpose stops its Server", async () => {
  // A short TMPDIR, cleaned by this test: the launcher's socket directories go there.
  const temporary = await mkdtemp("/tmp/luciole-t-");
  const run = await mkdtemp(join(tmpdir(), "luciole-local-"));
  try {
    await copyFile(binary, join(run, "notes"));
    // A crashed local Client of this app, on a note: restored though the socket is new.
    await leaveCrashedSession(join(run, ".local/state"), "notes", "local:notes", "/notes/1");
    const log = join(run, "screen.log");
    const client = Bun.spawn(inPty(log, "./notes"), {
      cwd: run,
      env: {
        HOME: run,
        TERM: "xterm-256color",
        PATH: "/usr/bin:/bin",
        TMPDIR: temporary,
        XDG_RUNTIME_DIR: temporary,
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    let screen = "";
    const shown = () => {
      screen = existsSync(log) ? Bun.stripANSI(readFileSync(log, "utf8")) : "";
      return screen.includes("Getting around");
    };
    await until(shown, WAIT_MS, () => screen);
    // Listening now on its socket in the runtime directory, no TCP port.
    const sockets = () =>
      readdirSync(join(temporary, "luciole")).filter((entry) => entry.endsWith(".sock"));
    expect(sockets()).toHaveLength(1);
    await Bun.write(join(run, "stop"), "");
    // Ctrl+C quits the Client on purpose, which stops its Server and removes the socket.
    await exited(client);
    // The Server's data lives where the user ran it; its log in their state directory.
    expect(existsSync(join(run, "notes.sqlite"))).toBe(true);
    expect(existsSync(join(run, ".local/state/luciole/notes/server.log"))).toBe(true);
    await until(
      () => sockets().length === 0,
      WAIT_MS,
      () => sockets().join("\n"),
    );
  } finally {
    await rm(run, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}, 60000);

const SshCall = z.object({ pid: z.number(), args: z.array(z.string()) });
async function sshCalls(file: string) {
  const text = await Bun.file(file)
    .text()
    .catch(() => "");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => SshCall.parse(JSON.parse(line)));
}

/** A remote host for --on: its HOME, its runtime directory, the fake ssh's settings. */
async function fakeHost() {
  const home = await mkdtemp(join(tmpdir(), "luciole-remote-"));
  // Short: socket paths must fit sun_path.
  const runtime = await mkdtemp("/tmp/luciole-rrt-");
  const log = join(home, "ssh.jsonl");
  return {
    home,
    log,
    env: {
      ...process.env,
      LUCIOLE_SSH: join(work, "ssh"),
      FAKE_SSH_LOG: log,
      FAKE_REMOTE_HOME: home,
      FAKE_REMOTE_RUNTIME: runtime,
    },
    installed: join(home, `.local/share/luciole/apps/notes/${identity.buildId}/notes`),
    /** Stops whatever Server is left there, then removes the host. */
    async remove() {
      for (const entry of readdirSync(join(runtime, "luciole")).filter((e) => e.endsWith(".sock")))
        await fetch("http://localhost/lifetime/stop", {
          method: "POST",
          unix: join(runtime, "luciole", entry),
        }).catch(() => undefined);
      await rm(home, { recursive: true, force: true });
      await rm(runtime, { recursive: true, force: true });
    },
  };
}

/** A Client of a --on Server, as the binary runs one: pinging, able to leave. */
const clientOf = (url: string, id = "test") =>
  connect(url, undefined, { LUCIOLE_LIFETIME_CLIENT: id, LUCIOLE_PING_MS: "100" });
const Health = z.object({ buildId: z.string(), pid: z.number() });
async function health(url: string) {
  const connection = await connect(url);
  const response = await connection.fetch?.(new URL("/health", connection.url), {});
  return Health.parse(await response?.json());
}

test("--on installs once, verifies the install, and serves through a tunnel", async () => {
  const host = await fakeHost();
  const messages: string[] = [];
  const options = {
    identity,
    id: serverId("ssh:test/notes"),
    graceMs: 60_000,
    self: binary,
    log: (message: string) => messages.push(message),
    env: host.env,
  };
  try {
    // Two launches at once (two session keys): one uploads, the other waits for it.
    const servers = await Promise.all([
      runOn("alice@host.example", { ...options, id: serverId("ssh:alice/notes") }),
      runOn("host.example:2222", options),
    ]);
    expect(await readBinaryIdentity(host.installed)).toEqual(identity);
    for (const server of servers)
      expect(await health(server.url)).toMatchObject({ buildId: identity.buildId });
    const calls = await sshCalls(host.log);
    expect(calls.some(({ args }) => args.includes("-p") && args.includes("2222"))).toBe(true);
    expect(calls.some(({ args }) => args.includes("alice@host.example"))).toBe(true);
    // The tunnel notices a dead connection by itself.
    expect(calls.some(({ args }) => args.includes("ServerAliveInterval=10"))).toBe(true);
    for (const server of servers) {
      await (await clientOf(server.url)).managed?.leave();
      await server.stop();
    }
    // Installed and intact: the next launch uploads nothing.
    messages.length = 0;
    const again = await runOn("host.example", options);
    expect(messages).toEqual([]);
    await (await clientOf(again.url)).managed?.leave();
    await again.stop();
    // Damaged or altered on the host: reinstalled, never run as found.
    await appendFile(host.installed, "tampered");
    const repaired = await runOn("host.example", options);
    expect(messages.join("\n")).toContain("does not match its SHA256SUMS: reinstalling");
    expect(await Bun.file(host.installed).bytes()).toEqual(await Bun.file(binary).bytes());
    await (await clientOf(repaired.url)).managed?.leave();
    await repaired.stop();
    // With no binary for that platform at hand, the launch is refused instead.
    await appendFile(host.installed, "tampered");
    expect(
      messageOf(
        await rejectionOf(
          runOn("host.example", {
            ...options,
            identity: { ...identity, target: "bun-linux-riscv" },
          }),
        ),
      ),
    ).toContain("does not match its SHA256SUMS (damaged or altered)");
  } finally {
    await host.remove();
  }
}, 90000);

test("--on: a lost Client finds its Server again; a cut tunnel comes back by itself", async () => {
  const host = await fakeHost();
  const messages: string[] = [];
  const options = {
    identity,
    id: serverId("ssh:host.example/notes"),
    graceMs: 60_000,
    self: binary,
    log: (message: string) => messages.push(message),
    env: host.env,
  };
  try {
    const first = await runOn("host.example", options);
    const pid = (await health(first.url)).pid;
    // The Client dies without leaving (its tunnel with it): the Server stays, in grace.
    await first.stop();
    messages.length = 0;
    const second = await runOn("host.example", options);
    expect(messages).toContain("notes on host.example: back to its running Server");
    expect((await health(second.url)).pid).toBe(pid);
    // The network drops: the tunnel is killed under a living Client.
    // The Client's pings, with no deadline on their answers: a cut tunnel refuses at once,
    // so how long a live one takes on a loaded host never decides what is seen.
    const { socket } = await connect(second.url);
    const client = keepAlive(
      (input, init) => fetch(input, { ...init, signal: undefined, unix: socket }),
      "test",
      100,
    );
    const seen: boolean[] = [];
    client.watch((reachable) => seen.push(reachable));
    const tunnels = (await sshCalls(host.log)).filter(({ args }) => args.includes("-N"));
    process.kill(tunnels.at(-1)?.pid ?? 0, "SIGKILL");
    await until(() => seen.includes(false), WAIT_MS);
    // Started again after 1 s, on the same local socket: the same Server answers.
    await until(() => seen.at(-1) === true, WAIT_MS);
    expect(seen).toEqual([false, true]);
    expect((await health(second.url)).pid).toBe(pid);
    await client.leave();
    await second.stop();
  } finally {
    await host.remove();
  }
}, 90000);

test("--on a host of another platform needs a binary of the same build for it", async () => {
  const remoteHome = await mkdtemp(join(tmpdir(), "luciole-remote-"));
  const env = {
    ...process.env,
    LUCIOLE_SSH: join(work, "ssh"),
    FAKE_SSH_LOG: join(remoteHome, "ssh.jsonl"),
    FAKE_REMOTE_HOME: remoteHome,
  };
  const options = {
    identity: { ...identity, target: "bun-linux-riscv" },
    id: serverId("ssh:host.example/notes"),
    graceMs: 0,
    self: binary,
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
    await Bun.write(other, `luciole-binary:1:notes:0000:${hostTarget()};`);
    expect(
      messageOf(await rejectionOf(runOn("host.example", { ...options, target: other }))),
    ).toContain(`needs notes ${identity.buildId}`);
    expect(existsSync(join(remoteHome, ".local/share/luciole/apps/notes"))).toBe(false);
    expect(messageOf(await rejectionOf(runOn("-oProxyCommand=x", options)))).toContain(
      'cannot start with "-"',
    );
  } finally {
    await rm(remoteHome, { recursive: true, force: true });
  }
}, 60000);

test("--on hands the application's arguments over stdin, never on a command line", async () => {
  const host = await fakeHost();
  const options = {
    identity,
    id: serverId("ssh:args/notes"),
    graceMs: 60_000,
    self: binary,
    log: () => {},
    env: host.env,
  };
  try {
    // Notes declares none: the remote Server refuses any, which proves they reached it.
    const refused = await rejectionOf(
      runOn("host.example", { ...options, launch: { args: { v: 1, argv: ["--secret-flag"] } } }),
    );
    expect(messageOf(refused)).toContain("Unknown argument --secret-flag");
    const calls = await sshCalls(host.log);
    expect(calls.some(({ args }) => args.join(" ").includes("--env-stdin"))).toBe(true);
    expect(calls.some(({ args }) => args.join(" ").includes("--secret-flag"))).toBe(false);
    const server = await runOn("host.example", {
      ...options,
      launch: { args: { v: 1, argv: [] } },
    });
    expect(await health(server.url)).toMatchObject({ buildId: identity.buildId });
    await (await clientOf(server.url)).managed?.leave();
    await server.stop();
  } finally {
    await host.remove();
  }
}, 90000);
