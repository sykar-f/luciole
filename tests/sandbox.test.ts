/**
 * The `sandbox` mode on macOS (docs/EMBEDDING.md, step 7): what the generated Seatbelt
 * profile really lets a child do, the egress proxy, the IPC channel of mediated
 * capabilities, and an application opened by URL, sandboxed, end to end. Seatbelt exists
 * on macOS only: elsewhere these tests are skipped, explicitly (Linux is step 8).
 */
import { test, expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect as connectTcp } from "node:net";
import { createTestRenderer } from "@opentui/core/testing";
import { build } from "../src/build";
import { Capabilities } from "../src/capabilities";
import { messageOf } from "../src/guards";
import { prepareOrigin, SANDBOX_HEADER } from "../src/generic/prepare";
import type { HostRequest } from "../src/host";
import { directories } from "../src/launcher/paths";
import { generatePublisherKey, readPublisherKey } from "../src/publisher";
import {
  beyond,
  enforcement,
  mergeCapabilities,
  parseAllowFlags,
  unenforceable,
} from "../src/sandbox/grants";
import { answer } from "../src/sandbox/ipc";
import { createPermissions, type Question } from "../src/sandbox/permissions";
import { sandboxed, seatbeltProfile, type ServerRoute } from "../src/sandbox/profile";
import { hostAllowed, startProxy } from "../src/sandbox/proxy";
import { buildChild, sandboxRuntime, sandboxSupported } from "../src/sandbox/runtime";
import { openSandbox } from "../src/sandbox/spawn";
import { spawnPty } from "../src/vt/pty";
import { VtTerminalRenderable } from "../src/vt/gaps";
import { launch, until } from "./helpers";

const macOS = test.skipIf(!sandboxSupported());
const NONE = Capabilities.parse({});
const caps = (value: unknown) => Capabilities.parse(value);
const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "airtty-sandbox-test-")));
const SRC = resolve("src");

type Outcome = { ok: boolean; detail: string };
/**
 * Runs `script` (Bun, one JSON line `{ ok, detail }` on stdout) on a PTY under the profile
 * generated for `granted`, as the host runs a sandboxed Client.
 */
async function inSandbox(
  script: string,
  granted: Capabilities,
  options: { server?: ServerRoute; proxyPort?: number; ipc?: (message: unknown) => void } = {},
): Promise<Outcome & { profile: string; tty: string }> {
  const tmp = scratch();
  let output = "";
  let profile = "";
  let tty = "";
  const code = await new Promise<number | null>((done, fail) => {
    try {
      spawnPty({
        cols: 80,
        rows: 24,
        cwd: tmp,
        environment: "replace",
        env: {
          PATH: "/usr/bin:/bin",
          HOME: tmp,
          TMPDIR: tmp,
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        },
        ipc: options.ipc,
        command: (slave) => {
          tty = slave;
          profile = seatbeltProfile({
            runtime: sandboxRuntime(),
            capabilities: granted,
            tmp,
            readable: [],
            writable: [],
            tty: slave,
            server: options.server ?? { kind: "proxy" },
            proxyPort: options.proxyPort,
          });
          return sandboxed(profile, [sandboxRuntime().bun, "-e", script]);
        },
        onData: (bytes) => (output += new TextDecoder().decode(bytes)),
        onExit: done,
      });
    } catch (error: unknown) {
      fail(error);
    }
  });
  rmSync(tmp, { recursive: true, force: true });
  const line = output.split(/\r?\n/).findLast((l) => l.startsWith('{"ok"'));
  if (!line) return { ok: false, detail: `exit ${code}: ${output.slice(-500)}`, profile, tty };
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== "object" || parsed === null || !("ok" in parsed) || !("detail" in parsed))
    throw new Error(line);
  return { ok: parsed.ok === true, detail: String(parsed.detail), profile, tty };
}
/** A script body whose returned value (or thrown error) becomes the outcome. */
const attempt = (body: string) =>
  `const report=(ok,detail)=>console.log(JSON.stringify({ok,detail:String(detail)}));` +
  `try{const r=await (async()=>{${body}})();report(true,r)}catch(e){report(false,e.code??e.message)}`;

macOS(
  "the profile opens the PTY by its exact path, and Bun and OpenTUI start under it",
  async () => {
    const run = await inSandbox(
      attempt(
        `process.stdin.setRawMode(true);process.stdin.setRawMode(false);` +
          `const {createTestRenderer}=await import(${JSON.stringify(Bun.resolveSync("@opentui/core/testing", SRC))});` +
          `const {renderer}=await createTestRenderer({width:10,height:2});renderer.destroy();return "raw mode, renderer"`,
      ),
      // The test's own renderer import is read from node_modules, which the runtime opens.
      NONE,
    );
    expect(run).toMatchObject({ ok: true, detail: "raw mode, renderer" });
    expect(run.profile).toContain("(deny default)");
    expect(run.profile).toContain(`(allow file-ioctl (literal "${run.tty}"))`);
    expect(run.profile).not.toContain("ttys[0-9]");
  },
);

macOS("another terminal of the user stays closed to the child", async () => {
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
    expect(run).toMatchObject({ ok: false, detail: "EPERM" });
  } finally {
    holder.kill();
  }
});

macOS("~/.ssh and ungranted paths are unreadable; writes land only where granted", async () => {
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
    if (existsSync(secret))
      expect(await read(secret)).toMatchObject({ ok: false, detail: "EPERM" });
    writeFileSync(join(home, "outside.txt"), "not granted");
    expect(await read(join(home, "outside.txt"))).toMatchObject({ ok: false, detail: "EPERM" });
    expect(await write(join(home, "granted/new.txt"))).toMatchObject({ ok: true });
    expect(readFileSync(join(home, "granted/new.txt"), "utf8")).toBe("x");
    expect(await write(join(home, "readonly/new.txt"))).toMatchObject({
      ok: false,
      detail: "EPERM",
    });
    expect(await write(join(home, "outside-new.txt"))).toMatchObject({
      ok: false,
      detail: "EPERM",
    });
    expect(existsSync(join(home, "outside-new.txt"))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

macOS("the clipboard's service is out of reach, even through a granted binary", async () => {
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

const TCP_TIMEOUT_MS = 2000;
const tcp = (port: number) =>
  attempt(
    `return await new Promise((ok,no)=>{const s=require("node:net").connect({host:"127.0.0.1",port:${port}});` +
      `const t=setTimeout(()=>no(new Error("timeout")),${TCP_TIMEOUT_MS});` +
      `s.on("connect",()=>{clearTimeout(t);s.destroy();ok("connected")});s.on("error",e=>{clearTimeout(t);no(e)})})`,
  );

macOS("the network: the Server's port and the proxy, which applies the host list", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (r) => new Response(`server ${new URL(r.url).host}`),
  });
  const other = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("other") });
  const granted = caps({ net: ["api.test"] });
  const proxy = await startProxy({ allow: [...granted.net], resolve: () => "127.0.0.1" });
  try {
    const route: ServerRoute = { kind: "loopback", port: server.port ?? 0 };
    const options = { server: route, proxyPort: proxy.port };
    // The Server, always; any other local port, never (a direct connection bypasses the proxy).
    expect(await inSandbox(tcp(server.port ?? 0), granted, options)).toMatchObject({ ok: true });
    expect(await inSandbox(tcp(other.port ?? 0), granted, options)).toMatchObject({ ok: false });
    // Through the proxy: the granted host is served, another is refused (403).
    const via = (host: string) =>
      inSandbox(
        attempt(
          `const r=await fetch("http://${host}:${other.port}/",{proxy:"http://127.0.0.1:${proxy.port}"});return r.status+" "+(await r.text())`,
        ),
        granted,
        options,
      );
    expect(await via("api.test")).toMatchObject({ ok: true, detail: "200 other" });
    expect(await via("evil.test")).toMatchObject({ ok: true, detail: "403 " });
    expect(proxy.decisions.map((d) => [d.host, d.allowed])).toEqual([
      ["api.test", true],
      ["evil.test", false],
    ]);
    // The child resolves no name: DNS is the proxy's.
    expect(
      await inSandbox(
        attempt(`return (await require("node:dns/promises").lookup("localhost")).address`),
        granted,
        options,
      ),
    ).toMatchObject({ ok: false });
  } finally {
    await proxy.stop();
    await server.stop(true);
    await other.stop(true);
  }
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
  expect(unenforceable(caps({ pty: true }))).toContain("every terminal");
  expect(
    unenforceable(caps({ fs: { read: ["/"], write: ["/"] }, net: ["*"], exec: true })),
  ).toContain("enforce nothing");
  expect(enforcement(merged).map((line) => [line.capability.split(" ")[0], line.by])).toEqual([
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

macOS(
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
          sandbox: true,
          directories: directories(env),
          env,
          confirm: () => Promise.resolve(true),
          log: (m) => void logs.push(m),
        });
        const performed: HostRequest[] = [];
        const sandbox = await openSandbox(
          { ...prepared, runtime: sandboxRuntime(), child },
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
      expect(logs.join("\n")).toContain(SANDBOX_HEADER);
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
  60_000,
);
