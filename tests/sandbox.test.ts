/**
 * The `sandbox` mode (docs/EMBEDDING.md, steps 7 and 8), with the mechanism this system
 * has (src/sandbox/mechanism.ts): Seatbelt on macOS; on Linux airtty-sandbox with
 * namespaces, under bubblewrap, or Landlock alone. What a confined child really can do,
 * the egress proxy, the IPC channel of mediated capabilities, and an application opened
 * by URL, sandboxed, end to end. Without a sandbox on this system (no prebuilt launcher,
 * say) these tests are skipped, explicitly: `bun scripts/linux-sandbox.ts` runs them in
 * Linux containers.
 */
import { test, expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect as connectTcp } from "node:net";
import { createTestRenderer } from "@opentui/core/testing";
import { z } from "zod";
import { build } from "../packages/airtty/src/build";
import { Capabilities } from "../packages/airtty/src/capabilities";
import { messageOf } from "../packages/airtty/src/guards";
import { prepareOrigin, sandboxHeader } from "../packages/airtty/src/generic/prepare";
import type { HostRequest } from "../packages/airtty/src/host";
import { directories } from "../packages/airtty/src/launcher/paths";
import { generatePublisherKey, readPublisherKey } from "../packages/airtty/src/publisher";
import { confine, scratch as newScratch } from "../packages/airtty/src/sandbox/confine";
import {
  beyond,
  enforcement,
  mergeCapabilities,
  parseAllowFlags,
  unenforceable,
} from "../packages/airtty/src/sandbox/grants";
import { answer } from "../packages/airtty/src/sandbox/ipc";
import { launcherPolicy, linuxCommand } from "../packages/airtty/src/sandbox/linux";
import type { LinuxMechanism, Mechanism } from "../packages/airtty/src/sandbox/mechanism";
import { createPermissions, type Question } from "../packages/airtty/src/sandbox/permissions";
import { hostAllowed, startProxy } from "../packages/airtty/src/sandbox/proxy";
import {
  buildChild,
  sandboxAvailability,
  sandboxRuntime,
} from "../packages/airtty/src/sandbox/runtime";
import { openSandbox } from "../packages/airtty/src/sandbox/spawn";
import { confineServer } from "../packages/airtty/src/sandbox/server";
import { startAppServer } from "../packages/airtty/src/dev/supervisor";
import { spawnPty } from "../packages/airtty/src/vt/pty";
import { VtTerminalRenderable } from "../packages/airtty/src/vt/gaps";
import { launch, until } from "./helpers";

const availability = sandboxAvailability();
const mechanism: Mechanism | undefined = availability.mechanism;
const confined = test.skipIf(!mechanism);
const onMacOS = test.skipIf(mechanism?.kind !== "seatbelt");
const onLinux = test.skipIf(!mechanism || mechanism.kind === "seatbelt");
/** Whether the mechanism gives the child a devpts of its own (the `pty` capability). */
const privateDevpts = mechanism?.kind === "userns" || mechanism?.kind === "bwrap";
const NONE = Capabilities.parse({});
const caps = (value: unknown) => Capabilities.parse(value);
const scratch = () => newScratch().path;
const SRC = resolve("packages/airtty/src");
/** Refusals, as each mechanism reports them: Seatbelt, Landlock, nothing mounted (bwrap). */
const REFUSED = /^(EPERM|EACCES|ENOENT|EROFS|ECONNREFUSED|ENETUNREACH)$/;

type Outcome = { ok: boolean; detail: string };
type Confined = {
  /** Runs `script` (Bun, one JSON line `{ ok, detail }` on stdout) confined. */
  run(script: string): Promise<Outcome>;
  profile: () => string;
  tty: () => string;
  proxyDecisions: () => readonly { host: string; allowed: boolean }[];
  close(): Promise<void>;
};
/**
 * The confinement a sandboxed Client gets for `granted` (src/sandbox/confine.ts), with its
 * Server at `server` (a loopback port by default, nothing listening). Scripts find the
 * Server's address in AIRTTY_TEST_SERVER and the proxy in HTTP_PROXY.
 */
async function confinedFor(
  granted: Capabilities,
  options: { server?: string; readable?: string[] } = {},
): Promise<Confined> {
  if (!mechanism) throw new Error("no sandbox here");
  const tmp = newScratch();
  const url = options.server ?? "http://127.0.0.1:9";
  const confinement = await confine({
    mechanism,
    runtime: sandboxRuntime(),
    granted,
    tmp: tmp.path,
    readable: options.readable ?? [],
    writable: [],
    server: { url, connection: { url, close() {} } },
    resolve: () => "127.0.0.1",
    onProfile: (text) => (profile = text),
  });
  let profile = "";
  let tty = "";
  const run = async (script: string) => {
    let output = "";
    const code = await new Promise<number | null>((done, fail) => {
      try {
        spawnPty({
          cols: 80,
          rows: 24,
          cwd: tmp.path,
          environment: "replace",
          env: {
            PATH: "/usr/bin:/bin",
            HOME: tmp.path,
            TMPDIR: tmp.path,
            BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
            AIRTTY_TEST_SERVER: new URL(confinement.serverUrl).host,
            ...confinement.env,
          },
          command: (slave) => {
            tty = slave;
            return confinement.command(slave, [sandboxRuntime().bun, "-e", script]);
          },
          onData: (bytes) => (output += new TextDecoder().decode(bytes)),
          onExit: done,
        });
      } catch (error: unknown) {
        fail(error);
      }
    });
    const line = output.split(/\r?\n/).findLast((l) => l.startsWith('{"ok"'));
    if (!line) return { ok: false, detail: `exit ${code}: ${output.slice(-800)}` };
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || !("ok" in parsed) || !("detail" in parsed))
      throw new Error(line);
    return { ok: parsed.ok === true, detail: String(parsed.detail) };
  };
  return {
    run,
    profile: () => profile,
    tty: () => tty,
    proxyDecisions: () => confinement.proxy?.decisions ?? [],
    close: async () => {
      await confinement.close();
      tmp.remove();
    },
  };
}
async function inSandbox(script: string, granted: Capabilities) {
  const sandbox = await confinedFor(granted);
  try {
    return { ...(await sandbox.run(script)), profile: sandbox.profile(), tty: sandbox.tty() };
  } finally {
    await sandbox.close();
  }
}
/** A script body whose returned value (or thrown error) becomes the outcome. */
const attempt = (body: string) =>
  // It exits once it reported: an open socket would keep it running.
  `const report=(ok,detail)=>{console.log(JSON.stringify({ok,detail:String(detail)}));setTimeout(()=>process.exit(0),50)};` +
  `try{const r=await (async()=>{${body}})();report(true,r)}catch(e){report(false,e.code??e.message)}`;

confined("Bun and OpenTUI start confined, raw mode on their own terminal included", async () => {
  const run = await inSandbox(
    attempt(
      `process.stdin.setRawMode(true);process.stdin.setRawMode(false);` +
        `const {createTestRenderer}=await import(${JSON.stringify(Bun.resolveSync("@opentui/core/testing", SRC))});` +
        `const {renderer}=await createTestRenderer({width:10,height:2});renderer.destroy();return "raw mode, renderer"`,
    ),
    NONE,
  );
  expect(run).toMatchObject({ ok: true, detail: "raw mode, renderer" });
});

onMacOS("the Seatbelt profile names the PTY by its exact path", async () => {
  const run = await inSandbox(attempt(`return "ok"`), NONE);
  expect(run.profile).toContain("(deny default)");
  expect(run.profile).toContain(`(allow file-ioctl (literal "${run.tty}"))`);
  expect(run.profile).not.toContain("ttys[0-9]");
});

confined("another terminal of the user stays closed to the child", async () => {
  // A PTY this process holds, as another terminal window would.
  let victim = "";
  const holder = spawnPty({
    cols: 10,
    rows: 5,
    command: (slave) => {
      victim = slave;
      return ["/bin/sleep", "5"];
    },
    onData: () => {},
    onExit: () => {},
  });
  try {
    const run = await inSandbox(
      attempt(`require("node:fs").openSync(${JSON.stringify(victim)},"r+");return "opened"`),
      NONE,
    );
    expect(run.ok).toBe(false);
    expect(run.detail).toMatch(REFUSED);
  } finally {
    holder.kill();
  }
});

confined("~/.ssh and ungranted paths are unreadable; writes land only where granted", async () => {
  const home = scratch();
  try {
    mkdirSync(join(home, "granted"));
    mkdirSync(join(home, "readonly"));
    writeFileSync(join(home, "readonly/data.txt"), "granted data");
    const secret = join(homedir(), ".ssh/config");
    const granted = caps({
      fs: { read: [join(home, "readonly")], write: [join(home, "granted")] },
    });
    const read = (path: string) =>
      inSandbox(
        attempt(`return require("node:fs").readFileSync(${JSON.stringify(path)},"utf8")`),
        granted,
      );
    const write = (path: string) =>
      inSandbox(
        attempt(`require("node:fs").writeFileSync(${JSON.stringify(path)},"x");return "written"`),
        granted,
      );
    expect(await read(join(home, "readonly/data.txt"))).toMatchObject({
      ok: true,
      detail: "granted data",
    });
    // The real ~/.ssh when there is one, and an ungranted file in any case.
    if (existsSync(secret)) {
      const ssh = await read(secret);
      expect(ssh.ok).toBe(false);
      expect(ssh.detail).toMatch(REFUSED);
    }
    writeFileSync(join(home, "outside.txt"), "not granted");
    const outside = await read(join(home, "outside.txt"));
    expect(outside.ok).toBe(false);
    expect(outside.detail).toMatch(REFUSED);
    expect(await write(join(home, "granted/new.txt"))).toMatchObject({ ok: true });
    expect(readFileSync(join(home, "granted/new.txt"), "utf8")).toBe("x");
    for (const path of [join(home, "readonly/new.txt"), join(home, "outside-new.txt")]) {
      const denied = await write(path);
      expect(denied.ok).toBe(false);
      expect(denied.detail).toMatch(REFUSED);
    }
    expect(existsSync(join(home, "outside-new.txt"))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

onMacOS("the clipboard's service is out of reach, even through a granted binary", async () => {
  const run = await inSandbox(
    attempt(
      `const r=Bun.spawnSync(["/usr/bin/pbcopy"],{stdin:new TextEncoder().encode("from the sandbox")});` +
        `if(r.exitCode!==0)throw new Error("pbcopy status "+r.exitCode);return "copied"`,
    ),
    caps({ exec: ["/usr/bin/pbcopy"] }),
  );
  // pbcopy starts (its exec is granted) and fails: the pasteboard mach-lookup is denied.
  expect(run).toMatchObject({ ok: false });
  expect(run.detail).toMatch(/pbcopy status [1-9]/);
});

onLinux("a session bus, a display socket: no Unix socket is reachable, even readable", async () => {
  // As the user's D-Bus or Wayland socket: a listening Unix socket the child can see.
  const home = scratch();
  const path = join(home, "bus.sock");
  let accepted = 0;
  const bus = createServer(() => void accepted++);
  await new Promise<void>((done) => bus.listen(path, done));
  try {
    const sandbox = await confinedFor(caps({ fs: { read: [home] } }));
    try {
      const run = await sandbox.run(
        attempt(
          `return await new Promise((ok,no)=>{const s=require("node:net").connect(${JSON.stringify(path)});` +
            `s.on("connect",()=>{s.destroy();ok("connected")});s.on("error",no)})`,
        ),
      );
      expect(run.ok).toBe(false);
      expect(accepted).toBe(0);
    } finally {
      await sandbox.close();
    }
  } finally {
    bus.close();
    rmSync(home, { recursive: true, force: true });
  }
});

const TCP_TIMEOUT_MS = 2000;
const tcp = (address: string) =>
  attempt(
    `const [host,port]=${address}.split(":");` +
      `return await new Promise((ok,no)=>{const s=require("node:net").connect({host,port:Number(port)});` +
      `const t=setTimeout(()=>no(new Error("timeout")),${TCP_TIMEOUT_MS});` +
      `s.on("connect",()=>{clearTimeout(t);s.destroy();ok("connected")});s.on("error",e=>{clearTimeout(t);no(e)})})`,
  );

confined("the network: the Server always, the proxy for granted hosts, nothing else", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (r) => new Response(`server ${new URL(r.url).pathname}`),
  });
  const other = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("other") });
  // A host list cannot be confined by Landlock alone: then only the Server's route is tested.
  const hosts = caps({ net: ["api.test"] });
  const granted = mechanism && unenforceable(hosts, mechanism) ? NONE : hosts;
  const sandbox = await confinedFor(granted, { server: `http://127.0.0.1:${server.port}` });
  try {
    // The Server, always (directly, or through the launcher's relay).
    expect(await sandbox.run(tcp("process.env.AIRTTY_TEST_SERVER"))).toMatchObject({ ok: true });
    expect(
      await sandbox.run(
        attempt(
          `const r=await fetch("http://"+process.env.AIRTTY_TEST_SERVER+"/x");return await r.text()`,
        ),
      ),
    ).toMatchObject({ ok: true, detail: "server /x" });
    // Any other local port, never: a direct connection bypasses the proxy.
    expect(await sandbox.run(tcp(JSON.stringify(`127.0.0.1:${other.port}`)))).toMatchObject({
      ok: false,
    });
    // The child resolves no name: DNS is the proxy's.
    expect(
      await sandbox.run(
        attempt(`return (await require("node:dns/promises").lookup("example.com")).address`),
      ),
    ).toMatchObject({ ok: false });
    if (granted === NONE) return;
    // Through the proxy: the granted host is served, another is refused (403).
    const via = (host: string) =>
      sandbox.run(
        attempt(
          `const r=await fetch("http://${host}:${other.port}/",{proxy:process.env.HTTP_PROXY});return r.status+" "+(await r.text())`,
        ),
      );
    expect(await via("api.test")).toMatchObject({ ok: true, detail: "200 other" });
    expect(await via("evil.test")).toMatchObject({ ok: true, detail: "403 " });
    expect(sandbox.proxyDecisions().map((d) => [d.host, d.allowed])).toEqual([
      ["api.test", true],
      ["evil.test", false],
    ]);
  } finally {
    await sandbox.close();
    await server.stop(true);
    await other.stop(true);
  }
});

onLinux("UDP never leaves without a network namespace, nor inside one", async () => {
  const run = await inSandbox(
    attempt(
      `const s=require("node:dgram").createSocket("udp4");` +
        `return await new Promise((ok,no)=>{s.on("error",no);setTimeout(()=>no(new Error("no answer")),2000);` +
        `s.send("x",53,"8.8.8.8",(e)=>e?no(e):ok("sent"))})`,
    ),
    NONE,
  );
  expect(run.ok).toBe(false);
});

const PTY_ECHO = attempt(
  `let out="";const t=new Bun.Terminal({cols:20,rows:5,data:(_t,d)=>{out+=new TextDecoder().decode(d)}});` +
    `const c=Bun.spawn(["/bin/echo","own-pty"],{terminal:t});await c.exited;await Bun.sleep(100);t.close();return out.trim()`,
);
test.skipIf(!privateDevpts)(
  "pty: the child's own terminals in a private devpts, none of the user's",
  async () => {
    let victim = "";
    const holder = spawnPty({
      cols: 10,
      rows: 5,
      command: (slave) => {
        victim = slave;
        return ["/bin/sleep", "5"];
      },
      onData: () => {},
      onExit: () => {},
    });
    try {
      const granted = caps({ pty: true, exec: ["/bin/echo"] });
      if (!mechanism) throw new Error("no sandbox here");
      expect(unenforceable(granted, mechanism)).toBeUndefined();
      expect(await inSandbox(PTY_ECHO, granted)).toMatchObject({ ok: true, detail: "own-pty" });
      // The user's terminal is not in the child's devpts: its path names nothing, or one of
      // the child's own; writing there never reaches the holder.
      const run = await inSandbox(
        attempt(
          `require("node:fs").writeFileSync(${JSON.stringify(victim)},"leak");return "written"`,
        ),
        granted,
      );
      expect(run.ok).toBe(false);
    } finally {
      holder.kill();
    }
  },
);

test("pty is refused where no private devpts exists; offered where one does", () => {
  const pty = caps({ pty: true });
  const linux = (kind: LinuxMechanism["kind"], landlockAbi = 8): LinuxMechanism => ({
    kind,
    landlockAbi,
    launcher: "/x/airtty-sandbox",
  });
  expect(unenforceable(pty, { kind: "seatbelt" })).toContain("/dev/ttys*");
  expect(unenforceable(pty, linux("landlock"))).toContain("/dev/pts");
  expect(unenforceable(pty, linux("userns"))).toBeUndefined();
  expect(unenforceable(pty, linux("bwrap"))).toBeUndefined();
  expect(unenforceable(caps({ net: ["a.test"] }), linux("landlock"))).toContain("any address");
  expect(unenforceable(caps({ net: ["a.test"] }), linux("userns"))).toBeUndefined();
  expect(unenforceable(caps({ exec: ["/bin/ls"] }), linux("bwrap", 0))).toContain("Landlock");
  expect(unenforceable(caps({ exec: ["/bin/ls"] }), linux("bwrap", 1))).toBeUndefined();
});

test("the Linux policy: structured, per mechanism, with the child's grants only", () => {
  const runtime = { bun: "/usr/local/bin/bun", libraries: [], code: ["/opt/airtty/src"] };
  const plan = (kind: LinuxMechanism["kind"], landlockAbi = 8) => ({
    mechanism: { kind, landlockAbi, launcher: "/opt/airtty-sandbox", bwrap: "/usr/bin/bwrap" },
    runtime,
    capabilities: caps({ fs: { read: ["/data"] }, exec: ["/bin/ls"], pty: true }),
    tmp: "/tmp/s",
    readable: ["/app"],
    writable: ["/state"],
    network: { mode: "isolated" as const, relays: [{ port: 3000, socket: "/run/s.sock" }] },
  });
  const userns = launcherPolicy(plan("userns"));
  expect(userns).toMatchObject({ version: 1, namespaces: true, devpts: true });
  for (const path of ["/usr", "/opt/airtty/src", "/app", "/data"])
    expect(userns.landlock?.read).toContain(path);
  expect(userns.landlock?.readWrite).toEqual(["/tmp/s", "/state", "/dev/null"]);
  for (const path of ["/usr/local/bin/bun", "/bin/ls"])
    expect(userns.landlock?.execute).toContain(path);
  expect(userns.landlock?.devices).toEqual(["/dev/ptmx", "/dev/pts"]);
  expect(userns.seccomp).toEqual({ denyUdp: false });
  // Home is never readable wholesale.
  expect(userns.landlock?.read).not.toContain(homedir());
  const landlock = launcherPolicy({ ...plan("landlock"), network: { mode: "ports", tcp: [3000] } });
  expect(landlock).toMatchObject({ namespaces: false, devpts: false, seccomp: { denyUdp: true } });
  expect(landlock.landlock?.minAbi).toBe(6);
  // bubblewrap: namespaces and mounts around the launcher; one argv, no shell.
  const argv = linuxCommand(plan("bwrap"), ["/usr/local/bin/bun", "child.js"]);
  expect(argv[0]).toBe("/usr/bin/bwrap");
  for (const flag of ["--unshare-net", "--unshare-user", "--dev", "--proc"])
    expect(argv).toContain(flag);
  const launcherAt = argv.lastIndexOf("/opt/airtty-sandbox");
  expect(argv.slice(launcherAt + 3)).toEqual(["--", "/usr/local/bin/bun", "child.js"]);
  expect(JSON.parse(argv[launcherAt + 2] ?? "")).toMatchObject({ namespaces: false });
  // Without Landlock, bubblewrap's mounts are all there is.
  expect(launcherPolicy(plan("bwrap", 0)).landlock).toBeNull();
});

test("the proxy matches hosts, suffixes and ports, and dials one host per connection", async () => {
  expect(hostAllowed(["api.test"], "API.test", 443)).toBe(true);
  expect(hostAllowed(["api.test:8080"], "api.test", 443)).toBe(false);
  expect(hostAllowed(["*.example.com"], "a.example.com", 443)).toBe(true);
  expect(hostAllowed(["*.example.com"], "example.com.evil", 443)).toBe(false);
  expect(hostAllowed(["*"], "anything", 1)).toBe(true);
  const seen: string[] = [];
  const upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (r) => {
      seen.push(r.headers.get("connection") ?? "");
      return new Response("ok");
    },
  });
  const proxy = await startProxy({ allow: ["a.test"], resolve: () => "127.0.0.1" });
  try {
    const raw = (request: string) =>
      new Promise<string>((done) => {
        const socket = connectTcp({ host: "127.0.0.1", port: proxy.port });
        let received = "";
        socket.on("data", (chunk) => (received += chunk.toString()));
        socket.on("close", () => done(received));
        socket.on("connect", () => socket.write(request));
      });
    const forwarded = await raw(
      `GET http://a.test:${upstream.port}/x HTTP/1.1\r\nHost: a.test\r\nConnection: keep-alive\r\nProxy-Authorization: x\r\n\r\n`,
    );
    expect(forwarded).toStartWith("HTTP/1.1 200");
    // Kept-alive requests must not ride a connection opened for another host.
    expect(seen).toEqual(["close"]);
    expect(await raw(`GET file:///etc/passwd HTTP/1.1\r\n\r\n`)).toStartWith("HTTP/1.1 400");
    expect(await raw(`CONNECT b.test:443 HTTP/1.1\r\n\r\n`)).toStartWith("HTTP/1.1 403");
  } finally {
    await proxy.stop();
    await upstream.stop(true);
  }
});

test("the host answers only what the origin was granted", async () => {
  const performed: HostRequest[] = [];
  const perform = (request: HostRequest) => {
    performed.push(request);
    return Promise.resolve(request.type === "secret" ? "s3cret" : undefined);
  };
  // No one to ask: what is not granted is refused.
  const permissions = createPermissions({
    granted: caps({ clipboard: { write: true }, secrets: ["token"] }),
  });
  const allow = (request: HostRequest) => permissions.allow(request);
  const ask = (id: number, request: unknown) =>
    answer({ kind: "request", id, request }, allow, perform);
  expect(await ask(1, { type: "clipboard.write", text: "x" })).toEqual({
    kind: "reply",
    id: 1,
    ok: true,
    value: null,
  });
  expect(await ask(2, { type: "clipboard.read" })).toMatchObject({
    id: 2,
    ok: false,
    denied: "clipboard.read",
  });
  expect(await ask(3, { type: "secret", name: "token" })).toMatchObject({
    ok: true,
    value: "s3cret",
  });
  expect(await ask(4, { type: "secret", name: "other" })).toMatchObject({
    ok: false,
    denied: "secrets",
  });
  expect(await ask(5, { type: "open-url", url: "file:///etc/passwd" })).toMatchObject({
    ok: false,
  });
  expect(await ask(6, { type: "spawn", argv: ["sh"] })).toMatchObject({ ok: false });
  // Not even a request: nothing to answer.
  expect(await answer("\x1b]52;c;eA==\x07", allow, perform)).toBeUndefined();
  expect(performed).toEqual([
    { type: "clipboard.write", text: "x" },
    { type: "secret", name: "token" },
  ]);
});

test("an undecided capability is asked once; the answer is kept and reported", async () => {
  const questions: string[] = [];
  const changes: string[] = [];
  let yes = true;
  const permissions = createPermissions({
    granted: NONE,
    denied: ["notify"],
    ask: (question) => {
      questions.push([question.capability, question.detail].filter(Boolean).join(" "));
      return Promise.resolve(yes);
    },
    onChange: ({ capability, state }) => void changes.push(`${capability} ${state}`),
  });
  expect(permissions.state("clipboard.write")).toBe("prompt");
  expect(permissions.state("notify")).toBe("denied");
  // Two requests at once: one question.
  const write = { type: "clipboard.write", text: "x" } as const;
  expect(await Promise.all([permissions.allow(write), permissions.allow(write)])).toEqual([
    true,
    true,
  ]);
  expect(await permissions.allow(write)).toBe(true);
  expect(permissions.state("clipboard.write")).toBe("granted");
  // Refused once, refused from then on without asking.
  expect(await permissions.allow({ type: "notify", title: "t" })).toBe(false);
  yes = false;
  expect(await permissions.allow({ type: "secret", name: "token" })).toBe(false);
  expect(await permissions.allow({ type: "secret", name: "token" })).toBe(false);
  expect(permissions.state("secrets")).toBe("denied");
  expect(questions).toEqual(["clipboard.write", "secrets token"]);
  expect(changes).toEqual(["clipboard.write granted", "secrets denied"]);
  expect(permissions.granted().clipboard.write).toBe(true);
  expect(permissions.denied()).toEqual(["notify", "secrets:token"]);
  expect(NONE.clipboard.write).toBe(false);
});

test("grants: flags, what is declared beyond, and what cannot be enforced", () => {
  const flags = parseAllowFlags(["--allow-exec=/bin/ls", "--allow-notify"], "/");
  expect(flags.exec).toEqual(["/bin/ls"]);
  expect(Capabilities.parse({}).exec).toBe(false);
  const merged = mergeCapabilities(flags, caps({ exec: ["/bin/cat"], net: ["a.test"] }));
  expect(merged.exec).toEqual(["/bin/ls", "/bin/cat"]);
  expect(beyond(caps({ net: ["a.test"], notify: true }), merged)).toBeUndefined();
  expect(beyond(caps({ net: ["b.test"] }), merged)?.net).toEqual(["b.test"]);
  const seatbelt: Mechanism = { kind: "seatbelt" };
  expect(unenforceable(caps({ pty: true }), seatbelt)).toContain("every terminal");
  expect(
    unenforceable(caps({ fs: { read: ["/"], write: ["/"] }, net: ["*"], exec: true }), seatbelt),
  ).toContain("enforce nothing");
  expect(
    enforcement(merged, seatbelt).map((line) => [line.capability.split(" ")[0], line.by]),
  ).toEqual([
    ["net", "proxy"],
    ["exec", "os"],
    ["notify", "host"],
  ]);
});

test("an OSC 52 written by a program never reaches the clipboard through the VT widget", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 40,
    height: 4,
  });
  const copies: string[] = [];
  renderer.copyToClipboardOSC52 = (text: string) => {
    copies.push(text);
    return true;
  };
  const answered: Uint8Array[] = [];
  const written: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array) => {
    written.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  };
  try {
    const terminal = new VtTerminalRenderable(renderer, {
      width: "100%",
      height: "100%",
      onData: (bytes) => answered.push(bytes),
    });
    renderer.root.add(terminal);
    // A set and a query, as an application writes them to its terminal.
    terminal.write(
      new TextEncoder().encode(`\x1b]52;c;${btoa("pwned")}\x07\x1b]52;c;?\x07visible`),
    );
    await renderOnce();
    expect(captureCharFrame()).toContain("visible");
  } finally {
    process.stdout.write = write;
    renderer.destroy();
  }
  expect(copies).toEqual([]);
  expect(written.join("")).not.toContain("]52;");
  expect(answered).toEqual([]);
});

/**
 * An application whose Client writes an OSC 52, asks `host` for the clipboard, then
 * reports the outcome with `host.notify` (its text on screen is split by cursor moves).
 */
const PROBE_APP = {
  "app/layout.tsx": `"use client";export default function Layout({children}){return children}`,
  "app/page.tsx": `import {Probe} from '../components/probe'; export default function Page(){return <Probe/>}`,
  "components/probe.tsx":
    `"use client";import {useEffect,useState} from 'react';import {CapabilityDenied,host} from 'airtty/client';` +
    `export function Probe(){const [s,setS]=useState('asking');useEffect(()=>{` +
    `process.stdout.write('\\x1b]52;c;'+btoa('osc-from-sandbox')+'\\x07');` +
    `host.clipboard.write('ipc-from-sandbox').then(()=>'copied',e=>e instanceof CapabilityDenied?'denied '+e.capability:'failed '+e.message)` +
    `.then(r=>{setS(r);return host.notify({title:r})})},[]);` +
    `return <text>probe {s}</text>}`,
};

confined(
  "an application opened by URL runs sandboxed: shown by the VT stream, host asked over IPC",
  async () => {
    const home = scratch();
    // Inside the repository (ignored by git: .airtty-*), where its Server resolves React.
    const app = mkdtempSync(resolve(".airtty-sandbox-probe-"));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_STATE_HOME: join(home, "state"),
      XDG_CACHE_HOME: join(home, "cache"),
    };
    for (const [name, text] of Object.entries(PROBE_APP)) {
      mkdirSync(join(app, name, ".."), { recursive: true });
      writeFileSync(join(app, name), text);
    }
    generatePublisherKey(env);
    await build(app, undefined, { signBundle: readPublisherKey(env) });
    const server = await launch(join(app, ".airtty/server/index.js"));
    const child = await buildChild();
    try {
      const logs: string[] = [];
      const open = async (allow: Capabilities, ask?: (question: Question) => Promise<boolean>) => {
        const prepared = await prepareOrigin(server.url, {
          allow,
          // Landlock alone is never the default: the test asks for the sandbox.
          mode: "sandbox",
          directories: directories(env),
          env,
          confirm: () => Promise.resolve(true),
          log: (m) => void logs.push(m),
        });
        const performed: HostRequest[] = [];
        const sandbox = await openSandbox(
          {
            ...prepared,
            mechanism: prepared.mechanism ?? { kind: "seatbelt" },
            runtime: sandboxRuntime(),
            child,
          },
          { env, ask, perform: (request) => (performed.push(request), Promise.resolve(undefined)) },
        );
        let output = "";
        let exited = false;
        const pty = sandbox.spawn({
          cols: 60,
          rows: 10,
          onData: (bytes) => (output += new TextDecoder().decode(bytes)),
          onExit: () => (exited = true),
        });
        const reported = () => performed.find((r) => r.type === "notify");
        await until(() => reported() !== undefined, 20_000).catch(() => {
          // What the child showed instead, for the failure to say.
          throw new Error(Bun.stripANSI(output).slice(-1500));
        });
        pty.write("\x03");
        await until(() => exited, 5000);
        await sandbox.close();
        const outcome = reported();
        return {
          prepared,
          performed: performed.filter((r) => r.type !== "notify"),
          outcome: outcome?.type === "notify" ? outcome.title : "",
          output,
        };
      };
      // The clipboard not granted: the request is refused by the host, never performed.
      const refused = await open(parseAllowFlags(["--allow-notify"]));
      expect(refused.prepared.mode).toBe("sandbox");
      if (mechanism) expect(logs.join("\n")).toContain(sandboxHeader(mechanism));
      expect(refused.outcome).toBe("denied clipboard.write");
      expect(refused.performed).toEqual([]);
      // The OSC 52 is only part of the VT stream, which the widget does not act on (above).
      expect(refused.output).toContain("]52;c;");
      // Not decided and not granted: the host asks the user, who grants it.
      const questions: Question[] = [];
      const asked = await open(parseAllowFlags(["--allow-notify"]), (q) => {
        questions.push(q);
        return Promise.resolve(true);
      });
      expect(questions).toEqual([{ capability: "clipboard.write" }]);
      expect(asked.outcome).toBe("copied");
      // Granted by a flag, remembered: the same request reaches the host's clipboard.
      const granted = await open(parseAllowFlags(["--allow-clipboard-write"]));
      expect(granted.outcome).toBe("copied");
      expect(granted.performed).toEqual([{ type: "clipboard.write", text: "ipc-from-sandbox" }]);
      expect(granted.prepared.granted.clipboard.write).toBe(true);
    } catch (error: unknown) {
      throw new Error(messageOf(error));
    } finally {
      await server.stop();
      rmSync(home, { recursive: true, force: true });
      rmSync(app, { recursive: true, force: true });
    }
  },
  120_000,
);

confined(
  "a sandboxed Client reports its failed page to the host over IPC",
  async () => {
    const home = scratch();
    const app = mkdtempSync(resolve(".airtty-sandbox-failure-"));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_STATE_HOME: join(home, "state"),
      XDG_CACHE_HOME: join(home, "cache"),
    };
    for (const [name, text] of Object.entries({
      "app/layout.tsx": `"use client";export default function Layout({children}){return children}`,
      "app/page.tsx": `export default function Page(){if(Date.now()>0)throw new Error("sandboxed page failed");return <text>never</text>}`,
    })) {
      mkdirSync(join(app, name, ".."), { recursive: true });
      writeFileSync(join(app, name), text);
    }
    generatePublisherKey(env);
    await build(app, undefined, { signBundle: readPublisherKey(env) });
    const server = await launch(join(app, ".airtty/server/index.js"));
    try {
      const prepared = await prepareOrigin(server.url, {
        allow: NONE,
        mode: "sandbox",
        directories: directories(env),
        env,
        confirm: () => Promise.resolve(true),
        log: () => {},
      });
      const failures: { path: string; message: string }[] = [];
      const sandbox = await openSandbox(
        {
          ...prepared,
          mechanism: prepared.mechanism ?? { kind: "seatbelt" },
          runtime: sandboxRuntime(),
          child: await buildChild(),
        },
        { env, perform: () => Promise.resolve(undefined), onFailure: (f) => void failures.push(f) },
      );
      let exited = false;
      const pty = sandbox.spawn({
        cols: 60,
        rows: 10,
        onData: () => {},
        onExit: () => (exited = true),
      });
      await until(() => failures.length > 0, 20_000);
      expect(failures[0]?.path).toBe("/");
      expect(failures[0]?.message).toContain("sandboxed page failed");
      pty.write("\x03");
      await until(() => exited, 5000);
      await sandbox.close();
    } finally {
      await server.stop();
      rmSync(home, { recursive: true, force: true });
      rmSync(app, { recursive: true, force: true });
    }
  },
  120_000,
);

/** A stand-in Server: listens on PORT, tries to leave its box, says how it went. */
const ESCAPING_SERVER = (canary: string, outside: string, data: string, service: number) => `
import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
const attempt = async (run) => { try { await run(); return "allowed"; } catch (e) { return e?.code ?? String(e); } };
const dial = (port) => new Promise((done, fail) => { const s = connect(port, "127.0.0.1", () => { s.end(); done(); }); s.on("error", fail); });
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch: async () => Response.json({
  readOutside: await attempt(() => readFileSync(${JSON.stringify(canary)}, "utf8")),
  writeOutside: await attempt(() => writeFileSync(${JSON.stringify(join(outside, "written"))}, "x")),
  writeData: await attempt(() => writeFileSync(${JSON.stringify(join(data, "db"))}, "x")),
  localService: await attempt(() => dial(${service})),
  spawn: await attempt(() => Bun.spawnSync(["/bin/echo", "x"]).stdout.toString()),
}) });
console.log(JSON.stringify({ ready: true, port: server.port }));
`;

onMacOS("a confined Server listens on its port and nothing leaves its box", async () => {
  const dir = mkdtempSync(join(tmpdir(), "airtty-server-sandbox-"));
  const outside = mkdtempSync(join(tmpdir(), "airtty-outside-"));
  const data = join(dir, "data");
  mkdirSync(join(dir, ".airtty/server"), { recursive: true });
  mkdirSync(data);
  const canary = join(outside, "canary");
  writeFileSync(canary, "secret");
  const service = createServer((socket) => socket.end("reached")).listen(0, "127.0.0.1");
  await new Promise((done) => service.once("listening", done));
  const address = service.address();
  const servicePort = typeof address === "object" && address ? address.port : 0;
  writeFileSync(
    join(dir, ".airtty/server/index.js"),
    ESCAPING_SERVER(canary, outside, data, servicePort),
  );
  const box = await confineServer({
    mechanism: { kind: "seatbelt" },
    runtime: sandboxRuntime(),
    granted: NONE,
    readable: [join(dir, ".airtty")],
    writable: [data],
  });
  try {
    const server = await startAppServer({
      directory: dir,
      env: box.env,
      command: box.command,
      stderr: () => {},
    });
    expect(server.port).toBe(box.port);
    const Attempts = z.record(z.string(), z.string());
    const { localService, ...attempts } = Attempts.parse(
      await (await fetch(`http://127.0.0.1:${server.port}/`)).json(),
    );
    expect(attempts).toEqual({
      readOutside: "EPERM",
      writeOutside: "EPERM",
      writeData: "allowed",
      spawn: "EPERM",
    });
    expect(localService).toMatch(REFUSED);
    await server.stop();
  } finally {
    await box.close();
    service.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a Server is not confined where no mechanism can let it listen yet", async () => {
  const refusal = await confineServer({
    mechanism: { kind: "userns", landlockAbi: 8, launcher: "/nonexistent" },
    runtime: sandboxRuntime(),
    granted: NONE,
    readable: [],
    writable: [],
  }).then(
    () => "",
    (error: unknown) => messageOf(error),
  );
  expect(refusal).toContain("needs Seatbelt");
});

onMacOS("a confined Server resolves packages through a readable node_modules link", async () => {
  // A project outside the repository links node_modules to the framework's packages
  // (studio): the resolver must follow the link, whose target is readable too.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "airtty-linked-")));
  const packages = join(root, "packages/node_modules");
  const app = join(root, "app");
  mkdirSync(join(packages, "greeting"), { recursive: true });
  writeFileSync(join(packages, "greeting/package.json"), `{"name":"greeting","main":"index.js"}`);
  writeFileSync(join(packages, "greeting/index.js"), `module.exports = { word: "linked" };`);
  mkdirSync(join(app, ".airtty/server"), { recursive: true });
  symlinkSync(packages, join(app, "node_modules"), "dir");
  writeFileSync(
    join(app, ".airtty/server/index.js"),
    `import { word } from "greeting";
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch: () => new Response(word) });
console.log(JSON.stringify({ ready: true, port: server.port }));`,
  );
  const box = await confineServer({
    mechanism: { kind: "seatbelt" },
    runtime: sandboxRuntime(),
    granted: NONE,
    readable: [join(app, ".airtty"), join(app, "node_modules")],
    writable: [],
  });
  try {
    const server = await startAppServer({
      directory: app,
      env: box.env,
      command: box.command,
      stderr: () => {},
    });
    expect(await (await fetch(`http://127.0.0.1:${server.port}/`)).text()).toBe("linked");
    await server.stop();
  } finally {
    await box.close();
    rmSync(root, { recursive: true, force: true });
  }
});
