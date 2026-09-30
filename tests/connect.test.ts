import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  configPath,
  connect,
  DEFAULT_URL,
  openTunnel,
  serverUrl,
  socketDirectory,
} from "../packages/luciole/src/connect";
import { messageOf } from "../packages/luciole/src/guards";
import { rejectionOf, until } from "./helpers";

let work: string, fakeSsh: string, server: ReturnType<typeof Bun.serve>;

// Stands for OpenSSH: logs its arguments, then forwards the -L socket to host:port, or
// fails like a refused key, or never finishes authenticating.
const FAKE_SSH = `
import { appendFileSync } from "node:fs";
import { connect, createServer } from "node:net";
const args = process.argv.slice(2);
appendFileSync(import.meta.dir + "/calls.jsonl", JSON.stringify({ pid: process.pid, args }) + "\\n");
const destination = args[args.length - 1];
if (destination.endsWith("refused.example")) {
  console.error(destination + ": Permission denied (publickey).");
  process.exit(255);
}
if (!destination.endsWith("silent.example")) {
  // socket:host:port, or socket:/remote/socket.
  const [socket, host, port] = args[args.indexOf("-L") + 1].split(":");
  createServer((client) => {
    const upstream = port === undefined ? connect({ path: host }) : connect(Number(port), host);
    client.pipe(upstream).pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  }).listen(socket);
}
setInterval(() => {}, 1000);
`;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "luciole-connect-"));
  fakeSsh = join(work, "ssh");
  await Bun.write(fakeSsh, `#!${process.execPath}\n${FAKE_SSH}`);
  await chmod(fakeSsh, 0o755);
  server = Bun.serve({ port: 0, fetch: (request) => new Response(new URL(request.url).pathname) });
});
afterAll(async () => {
  await server.stop(true);
  await rm(work, { recursive: true, force: true });
});

async function lastCall() {
  const lines = (await Bun.file(join(work, "calls.jsonl")).text()).trim().split("\n");
  const call: unknown = JSON.parse(lines[lines.length - 1]);
  const pid = typeof call === "object" && call && "pid" in call ? call.pid : undefined;
  const args = typeof call === "object" && call && "args" in call ? call.args : undefined;
  if (typeof pid !== "number" || !Array.isArray(args)) throw new Error("Unexpected fake ssh log");
  return { pid, args: args.map(String) };
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("--url, then LUCIOLE_URL, then the user's config file, then the default", async () => {
  const env = { XDG_CONFIG_HOME: join(work, "config") };
  const file = configPath("notes", env);
  expect(file).toBe(join(work, "config/luciole/notes.json"));
  const url = (argv: string[], extra: Record<string, string> = {}) =>
    serverUrl({ name: "notes", argv: ["bun", "index.js", ...argv], env: { ...env, ...extra } });
  expect(await url([])).toBe(DEFAULT_URL);
  await mkdir(dirname(file), { recursive: true });
  await Bun.write(file, JSON.stringify({ url: "ssh://me@notes.example" }));
  expect(await url([])).toBe("ssh://me@notes.example");
  expect(await url([], { LUCIOLE_URL: "https://env.example" })).toBe("https://env.example");
  expect(await url(["--url", "https://flag.example"], { LUCIOLE_URL: "https://env.example" })).toBe(
    "https://flag.example",
  );
  // A broken file is reported, never silently replaced by the default.
  await Bun.write(file, "{ url: ");
  expect(messageOf(await rejectionOf(url([])))).toContain(file);
  await Bun.write(file, JSON.stringify({ url: 3000 }));
  expect(messageOf(await rejectionOf(url([])))).toContain('expected { "url": "…" }');
  expect(messageOf(await rejectionOf(url(["--url"])))).toContain("--url needs a value");
});

test("ssh:// forwards a private socket to the remote Server and stops with the Client", async () => {
  const tunnel = await openTunnel(`ssh://alice@server.example:2222/127.0.0.1:${server.port}`, {
    ssh: fakeSsh,
  });
  if (!tunnel.fetch) throw new Error("An ssh tunnel provides its fetch");
  const response = await tunnel.fetch(new URL("/rsc?path=/", tunnel.url), {});
  expect(await response.text()).toBe("/rsc");
  const call = await lastCall();
  const socket = call.args[call.args.indexOf("-L") + 1].split(":")[0];
  expect(call.args).toEqual([
    "-N",
    "-o",
    "ExitOnForwardFailure=yes",
    "-L",
    `${socket}:127.0.0.1:${server.port}`,
    "-p",
    "2222",
    "--",
    "alice@server.example",
  ]);
  expect(alive(call.pid)).toBe(true);
  tunnel.close();
  const deadline = performance.now() + 3000;
  while (alive(call.pid) && performance.now() < deadline) await Bun.sleep(20);
  expect(alive(call.pid)).toBe(false);
  expect(await Bun.file(socket).exists()).toBe(false);
  // Defaults: the remote loopback, port 3000, the user's own ssh port and login.
  (await openTunnel("ssh://server.example", { ssh: fakeSsh })).close();
  const defaults = await lastCall();
  expect(defaults.args.slice(5)).toEqual(["--", "server.example"]);
  expect(defaults.args[4]).toEndWith(":127.0.0.1:3000");
});

test("ssh:// to a path forwards to a remote Unix socket, with the caller's options", async () => {
  const remote = join(socketDirectory("luciole-remote-"), "s");
  const upstream = Bun.serve({ unix: remote, fetch: () => new Response("over the socket") });
  try {
    const tunnel = await openTunnel(`ssh://server.example${remote}`, {
      ssh: fakeSsh,
      options: ["-o", "ControlPath=/x"],
    });
    if (!tunnel.fetch) throw new Error("An ssh tunnel provides its fetch");
    expect(await (await tunnel.fetch(new URL("/", tunnel.url), {})).text()).toBe("over the socket");
    const call = await lastCall();
    expect(call.args[4]).toEndWith(`:${remote}`);
    expect(call.args.slice(5)).toEqual(["-o", "ControlPath=/x", "--", "server.example"]);
    tunnel.close();
  } finally {
    await upstream.stop(true);
    await rm(dirname(remote), { recursive: true, force: true });
  }
});

test("unix: reaches a local socket; relative paths are refused", async () => {
  const socket = join(socketDirectory("luciole-local-"), "s");
  const upstream = Bun.serve({ unix: socket, fetch: (r) => new Response(new URL(r.url).pathname) });
  try {
    const connection = await connect(`unix:${socket}`);
    if (!connection.fetch) throw new Error("A socket connection provides its fetch");
    expect(await (await connection.fetch(new URL("/health", connection.url), {})).text()).toBe(
      "/health",
    );
    expect(messageOf(await rejectionOf(connect("unix:relative/s")))).toContain(
      "expected unix:/absolute/path",
    );
  } finally {
    await upstream.stop(true);
    await rm(dirname(socket), { recursive: true, force: true });
  }
});

test("a long TMPDIR still yields a socket path that fits", async () => {
  const long = join(work, "t".repeat(120));
  await mkdir(long);
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = long;
  try {
    const tunnel = await openTunnel(`ssh://server.example/${server.port}`, { ssh: fakeSsh });
    const call = await lastCall();
    const socket = call.args[call.args.indexOf("-L") + 1].split(":")[0];
    expect(socket.startsWith("/tmp/luciole-ssh-")).toBe(true);
    tunnel.close();
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
});

test("a signal while ssh authenticates stops ssh and removes the socket directory", async () => {
  // A Client still waiting for the tunnel (a passphrase prompt, say) is killed.
  const script = join(work, "waiting-client.ts");
  await Bun.write(
    script,
    `import { openTunnel } from ${JSON.stringify(resolve("packages/luciole/src/connect.ts"))};
await openTunnel("ssh://silent.example", { ssh: ${JSON.stringify(fakeSsh)} });`,
  );
  const calls = () => readFileSync(join(work, "calls.jsonl"), "utf8").length;
  const before = calls();
  const client = Bun.spawn([process.execPath, script], { stdout: "ignore", stderr: "ignore" });
  await until(() => calls() > before);
  const call = await lastCall();
  const directory = dirname(call.args[call.args.indexOf("-L") + 1].split(":")[0]);
  expect(existsSync(directory)).toBe(true);
  client.kill("SIGTERM");
  await client.exited;
  // The signal still ends the Client as it would have, after the tunnel is gone.
  expect(client.signalCode).toBe("SIGTERM");
  const deadline = performance.now() + 3000;
  while (alive(call.pid) && performance.now() < deadline) await Bun.sleep(20);
  expect(alive(call.pid)).toBe(false);
  expect(existsSync(directory)).toBe(false);
});

test("ssh failures, stalls and option-like hosts are explained", async () => {
  expect(
    messageOf(await rejectionOf(openTunnel("ssh://bob@refused.example", { ssh: fakeSsh }))),
  ).toContain("Permission denied (publickey)");
  expect(
    messageOf(
      await rejectionOf(openTunnel("ssh://silent.example", { ssh: fakeSsh, timeoutMs: 300 })),
    ),
  ).toContain("no tunnel after 300 ms");
  const stalled = await lastCall();
  const deadline = performance.now() + 3000;
  while (alive(stalled.pid) && performance.now() < deadline) await Bun.sleep(20);
  expect(alive(stalled.pid)).toBe(false);
  expect(
    messageOf(await rejectionOf(openTunnel("ssh://-oProxyCommand=x/", { ssh: fakeSsh }))),
  ).toContain('cannot start with "-"');
  expect(
    messageOf(await rejectionOf(openTunnel("ssh://server.example/admin", { ssh: fakeSsh }))),
  ).toContain("expected ssh://");
  expect(
    messageOf(
      await rejectionOf(openTunnel("ssh://nobody.example", { ssh: join(work, "missing") })),
    ),
  ).toContain("ENOENT");
});
