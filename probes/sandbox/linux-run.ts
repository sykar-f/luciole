/**
 * Linux side of the probe, run by probe.ts in a privileged container (bubblewrap needs
 * user namespaces). Runs child.ts under the bubblewrap plan generated from capabilities
 * and prints one JSON line: the Landlock ABI, the plan, and each assertion.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { Capabilities } from "./capabilities";
import { landlockAbi } from "./landlock-abi";
import { linuxPlan, landlockOnlyNet, PROXY_PORT, PROXY_SOCKET } from "./linux";
import { startProxy } from "./proxy";
import { ChildResult } from "./results";

const WORK = "/work";
const STDERR_CHARS = 200;
const HEX = 16;
const hex = (bits: bigint) => `0x${bits.toString(HEX)}`;
const here = import.meta.dir;
const bun = realpathSync(process.execPath);
const abi = landlockAbi();
for (const d of ["readable", "writable", "tmp", "outside"])
  mkdirSync(join(WORK, d), { recursive: true });
writeFileSync(join(WORK, "readable/data.txt"), "granted data");
mkdirSync("/root/.ssh", { recursive: true });
writeFileSync("/root/.ssh/config", "Host secret");

const allowedServer = Bun.serve({
  port: 0,
  hostname: "0.0.0.0",
  fetch: () => new Response("allowed host"),
});
const deniedServer = Bun.serve({
  port: 0,
  hostname: "0.0.0.0",
  fetch: () => new Response("denied host"),
});
const proxy = await startProxy({
  allow: ["allowed.test"],
  resolve: () => "127.0.0.1",
  path: join(WORK, "proxy.sock"),
});
const eth = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === "IPv4" && !i.internal)?.address;

async function run(caps: unknown, action: string[]) {
  const parsed = Capabilities.parse(caps);
  const plan = linuxPlan(parsed, {
    bun,
    code: [here],
    tmp: join(WORK, "tmp"),
    proxySocket: parsed.net.length ? join(WORK, "proxy.sock") : undefined,
    landlockAbi: abi,
  });
  const inner = [bun, join(here, "child.ts"), ...action];
  const argv =
    parsed.net.length && !parsed.net.includes("*")
      ? [bun, join(here, "relay.ts"), PROXY_SOCKET, String(PROXY_PORT), "--", ...inner]
      : inner;
  // Asynchronous: the proxy and the servers answer from this process's event loop.
  const child = Bun.spawn(["bwrap", ...plan.bwrap, "--", ...argv], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;
  const line = stdout.trim().split("\n").at(-1) ?? "";
  try {
    return ChildResult.parse(JSON.parse(line));
  } catch {
    return { ok: false, detail: `no result: ${stderr.trim().slice(0, STDERR_CHARS)}` };
  }
}

const net = { net: ["allowed.test"] };
const cases = [
  {
    name: "read granted path",
    expect: true,
    got: await run({ fs: { read: [join(WORK, "readable")] } }, [
      "read",
      join(WORK, "readable/data.txt"),
    ]),
  },
  {
    name: "read ~/.ssh (not mounted)",
    expect: false,
    got: await run({}, ["read", "/root/.ssh/config"]),
  },
  {
    name: "write granted path",
    expect: true,
    got: await run({ fs: { write: [join(WORK, "writable")] } }, [
      "write",
      join(WORK, "writable/out.txt"),
    ]),
  },
  {
    name: "write read-only granted path",
    expect: false,
    got: await run({ fs: { read: [join(WORK, "readable")] } }, [
      "write",
      join(WORK, "readable/out.txt"),
    ]),
  },
  {
    name: "write outside (not mounted)",
    expect: false,
    got: await run({}, ["write", join(WORK, "outside/out.txt")]),
  },
  { name: "pty without capability", expect: false, got: await run({}, ["pty"]) },
  { name: "pty with capability", expect: true, got: await run({ pty: true }, ["pty"]) },
  {
    name: "direct connection (network namespace)",
    expect: false,
    got: await run(net, ["tcp", `${eth}:${allowedServer.port}`]),
  },
  {
    name: "proxy → allowed host",
    expect: true,
    got: await run(net, [
      "fetch",
      `http://allowed.test:${allowedServer.port}/`,
      `http://127.0.0.1:${PROXY_PORT}`,
    ]),
  },
  {
    name: "proxy → other host (403)",
    expect: false,
    got: await run(net, [
      "fetch",
      `http://denied.test:${deniedServer.port}/`,
      `http://127.0.0.1:${PROXY_PORT}`,
    ]),
  },
  {
    name: "CONNECT → allowed host",
    expect: true,
    got: await run(net, [
      "connect",
      `127.0.0.1:${PROXY_PORT}`,
      `allowed.test:${allowedServer.port}`,
    ]),
  },
  {
    name: "net * shares the network",
    expect: true,
    got: await run({ net: ["*"] }, ["fetch", `http://${eth}:${allowedServer.port}/`]),
  },
];
await proxy.stop();
void allowedServer.stop(true);
void deniedServer.stop(true);
const sample = linuxPlan(
  Capabilities.parse({
    fs: { read: ["/data"], write: ["/out"] },
    net: ["api.example.com"],
    exec: ["/usr/bin/git"],
    clipboard: { write: true },
  }),
  {
    bun,
    code: ["/app"],
    tmp: "/tmp/app",
    proxySocket: "/run/host-proxy.sock",
    landlockAbi: abi,
  },
);
console.log(
  JSON.stringify({
    kernel: spawnSync("uname", ["-r"], { encoding: "utf8" }).stdout.trim(),
    bwrap: spawnSync("bwrap", ["--version"], { encoding: "utf8" }).stdout.trim(),
    landlockAbi: abi,
    cases: cases.map((c) => ({
      name: c.name,
      expect: c.expect,
      ok: c.got.ok,
      detail: c.got.detail,
      pass: c.got.ok === c.expect,
    })),
    proxyDecisions: proxy.decisions,
    sample: {
      bwrap: sample.bwrap,
      landlock: sample.landlock && {
        handledAccessFs: hex(sample.landlock.handledAccessFs),
        handledAccessNet: hex(sample.landlock.handledAccessNet),
        scoped: hex(sample.landlock.scoped),
        fsRules: sample.landlock.fsRules.map((r) => ({
          path: r.path,
          access: hex(r.access),
        })),
        netRules: sample.landlock.netRules.map((r) => ({
          port: r.port,
          access: hex(r.access),
        })),
      },
      seccomp: sample.seccomp,
      report: sample.report,
      landlockOnly: landlockOnlyNet(Capabilities.parse({ net: ["api.example.com:443"] }), abi),
    },
  }),
);
