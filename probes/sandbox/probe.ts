/**
 * Runs child.ts under Seatbelt profiles generated from capability lists and checks what
 * the OS really enforces. `--linux` also runs linux-run.ts in a privileged container
 * (Docker/OrbStack) for the bubblewrap layer. Writes results.json next to this file.
 *
 *   bun probes/sandbox/probe.ts [--linux]
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, release, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Capabilities, granted } from "./capabilities";
import { startProxy } from "./proxy";
import { ChildResult, LinuxSummary } from "./results";
import { profileFor, sandboxed, type Runtime } from "./seatbelt";

const RUNS = 15;
const STDERR_CHARS = 200;
const CONTAINER_ERROR_CHARS = 500;
const SUMMARY_CHARS = 80;
const DATE_CHARS = "YYYY-MM-DD".length;
const CONTAINER_TIMEOUT_MS = 300_000;
const here = import.meta.dir;
const root = dirname(dirname(here));
const bun = realpathSync(process.execPath);
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "airtty-sandbox-")));
for (const d of ["readable", "writable", "outside", "tmp"]) mkdirSync(join(scratch, d));
writeFileSync(join(scratch, "readable/data.txt"), "granted data");
writeFileSync(join(scratch, "outside/data.txt"), "not granted");
const sshConfig = join(homedir(), ".ssh/config");

// Non-system dylibs bun links (Nix installs ICU next to it): read access, nothing else.
const libraries = [
  ...new Set(
    spawnSync("otool", ["-L", bun], { encoding: "utf8" })
      .stdout.split("\n")
      .slice(1)
      .map((l) => l.trim().split(" ")[0] ?? "")
      .filter((p) => p.startsWith("/") && !p.startsWith("/usr/lib/") && !p.startsWith("/System/"))
      .map((p) => dirname(dirname(p))),
  ),
];
const runtime = (proxyPort?: number): Runtime => ({
  bun,
  libraries: [dirname(dirname(bun)), ...libraries],
  // The probe's child lives in the repository: its tsconfig lookups reach the root.
  code: [
    here,
    join(root, "node_modules"),
    ...["tsconfig.json", "tsconfig.base.json", "package.json"].map((f) => join(root, f)),
  ],
  tmp: join(scratch, "tmp"),
  proxyPort,
});

const allowedServer = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => new Response("allowed host"),
});
const deniedServer = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => new Response("denied host"),
});
const proxy = await startProxy({ allow: ["allowed.test"], resolve: () => "127.0.0.1" });
const proxyUrl = `http://127.0.0.1:${proxy.port}`;

async function run(argv: string[]) {
  const child = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: "/usr/bin:/bin", HOME: homedir(), TMPDIR: join(scratch, "tmp") },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;
  try {
    return ChildResult.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? ""));
  } catch {
    return { ok: false, detail: `no result: ${stderr.trim().slice(0, STDERR_CHARS)}` };
  }
}
const child = (action: string[]) => [bun, join(here, "child.ts"), ...action];
/** Runs one child action, sandboxed by the profile generated from `caps`. */
function inSandbox(caps: unknown, action: string[]) {
  const { profile } = profileFor(Capabilities.parse(caps), runtime(proxy.port));
  return run(sandboxed(profile, child(action)));
}
const bare = (action: string[]) => run(child(action));

type Case = {
  name: string;
  expect: boolean;
  got: ChildResult;
  check?: (r: ChildResult) => boolean;
};
const cases: Case[] = [];
const add = (
  name: string,
  expect: boolean,
  got: ChildResult,
  check?: (r: ChildResult) => boolean,
) => cases.push({ name, expect, got, check });

// Seatbelt's network filter: only `*` or `localhost` as a host, whatever the syntax.
for (const remote of ["example.com:443", "93.184.215.14:443"]) {
  const r = spawnSync(
    "/usr/bin/sandbox-exec",
    [
      "-p",
      `(version 1)(allow default)(allow network-outbound (remote ip "${remote}"))`,
      "/usr/bin/true",
    ],
    { encoding: "utf8" },
  );
  add(
    `SBPL rejects remote "${remote}"`,
    false,
    { ok: r.status === 0, detail: r.stderr.trim() },
    (x) => x.detail.includes("host must be * or localhost"),
  );
}
const manPage = readFileSync("/usr/share/man/man1/sandbox-exec.1", "utf8");
add("sandbox-exec present and marked DEPRECATED", true, {
  ok: existsSync("/usr/bin/sandbox-exec") && manPage.includes("DEPRECATED"),
  detail: "/usr/bin/sandbox-exec",
});

add("startup: bun under the base profile", true, await inSandbox({}, ["noop"]));
add("startup: React + OpenTUI native renderer", true, await inSandbox({}, ["boot"]));

const zone = await bare(["tz"]);
add(
  "timezone: same local zone as outside",
  true,
  await inSandbox({}, ["tz"]),
  (r) => r.detail === zone.detail,
);

const readable = { fs: { read: [join(scratch, "readable")] } };
add(
  "fs.read: granted path",
  true,
  await inSandbox(readable, ["read", join(scratch, "readable/data.txt")]),
);
add(
  "fs.read: other path",
  false,
  await inSandbox(readable, ["read", join(scratch, "outside/data.txt")]),
);
if (existsSync(sshConfig)) {
  add("~/.ssh/config readable without sandbox", true, await bare(["read", sshConfig]));
  add("~/.ssh/config denied in sandbox", false, await inSandbox({}, ["read", sshConfig]));
}
add(
  "fs.write: granted path",
  true,
  await inSandbox({ fs: { write: [join(scratch, "writable")] } }, [
    "write",
    join(scratch, "writable/out.txt"),
  ]),
);
add(
  "fs.write: path only readable",
  false,
  await inSandbox(readable, ["write", join(scratch, "readable/out.txt")]),
);
add(
  "fs.write: other path",
  false,
  await inSandbox({}, ["write", join(scratch, "outside/out.txt")]),
);

add("exec: denied without capability", false, await inSandbox({}, ["exec", "/bin/ls", scratch]));
add(
  "exec: listed binary",
  true,
  await inSandbox({ ...readable, exec: ["/bin/ls"] }, [
    "exec",
    "/bin/ls",
    join(scratch, "readable"),
  ]),
);
add(
  "exec: unlisted binary",
  false,
  await inSandbox({ exec: ["/bin/ls"] }, ["exec", "/bin/cat", join(scratch, "readable/data.txt")]),
);
// The grandchild (bun itself, allowed) inherits the profile: ~/.ssh stays unreadable.
add(
  "exec: sub-process inherits the sandbox",
  true,
  await inSandbox({ exec: [bun] }, ["exec", bun, join(here, "child.ts"), "read", sshConfig]),
  (r) => r.ok && r.detail.includes('"ok":false') && r.detail.includes("EPERM"),
);

add("pty: denied without capability", false, await inSandbox({}, ["pty"]));
add("pty: /dev/ptmx with capability", true, await inSandbox({ pty: true }, ["pty"]));

// Clipboard, keychain, LaunchServices: even with the binaries allowed, their mach
// services are denied. The find pasteboard is used, saved and restored.
const nonce = `airtty-probe-${crypto.randomUUID()}`;
const savedFind = spawnSync("/usr/bin/pbpaste", ["-pboard", "find"], { encoding: "utf8" }).stdout;
spawnSync("/usr/bin/pbcopy", ["-pboard", "find"], { input: nonce });
const tools = {
  exec: ["/usr/bin/pbpaste", "/usr/bin/pbcopy", "/usr/bin/security", "/usr/bin/open"],
};
add(
  "pasteboard readable without sandbox",
  true,
  await bare(["exec", "/usr/bin/pbpaste", "-pboard", "find"]),
  (r) => r.detail.includes(nonce),
);
add(
  "pasteboard: pbpaste blocked (mach-lookup)",
  false,
  await inSandbox(tools, ["exec", "/usr/bin/pbpaste", "-pboard", "find"]),
  (r) => !r.detail.includes(nonce),
);
const copied = await inSandbox(tools, ["exec", "/usr/bin/pbcopy", "-pboard", "find"]);
// Read now, before the pasteboard is restored: the nonce must have survived.
const untouched =
  spawnSync("/usr/bin/pbpaste", ["-pboard", "find"], { encoding: "utf8" }).stdout === nonce;
add("pasteboard: pbcopy blocked", false, copied, () => untouched);
spawnSync("/usr/bin/pbcopy", ["-pboard", "find"], { input: savedFind });
add(
  "keychain listable without sandbox",
  true,
  await bare(["exec", "/usr/bin/security", "list-keychains"]),
);
add(
  "keychain: securityd blocked",
  false,
  await inSandbox(tools, ["exec", "/usr/bin/security", "list-keychains"]),
);
// Finder is always running and -g -j keeps it in the background: harmless if allowed.
add(
  "open without sandbox",
  true,
  await bare(["exec", "/usr/bin/open", "-g", "-j", "-a", "Finder"]),
);
add(
  "open: LaunchServices blocked",
  false,
  await inSandbox(tools, ["exec", "/usr/bin/open", "-g", "-j", "-a", "Finder"]),
);

add("dns without sandbox", true, await bare(["dns", "localhost"]));
add("dns: no resolver in sandbox (no net)", false, await inSandbox({}, ["dns", "localhost"]));
const net = { net: ["allowed.test"] };
add(
  "dns: no resolver with net hosts (the proxy resolves)",
  false,
  await inSandbox(net, ["dns", "localhost"]),
);
add(
  "net: direct TCP denied by the OS",
  false,
  await inSandbox(net, ["tcp", `127.0.0.1:${allowedServer.port}`]),
);
add(
  "net: no net capability, proxy unreachable",
  false,
  await inSandbox({}, ["tcp", `127.0.0.1:${proxy.port}`]),
);
add(
  "net: proxy → allowed host",
  true,
  await inSandbox(net, ["fetch", `http://allowed.test:${allowedServer.port}/`, proxyUrl]),
);
add(
  "net: proxy → other host refused (403)",
  false,
  await inSandbox(net, ["fetch", `http://denied.test:${deniedServer.port}/`, proxyUrl]),
  (r) => r.detail.startsWith("403"),
);
add(
  "net: CONNECT tunnel → allowed host",
  true,
  await inSandbox(net, [
    "connect",
    `127.0.0.1:${proxy.port}`,
    `allowed.test:${allowedServer.port}`,
  ]),
);
add(
  "net: CONNECT → other host refused",
  false,
  await inSandbox(net, ["connect", `127.0.0.1:${proxy.port}`, `denied.test:${deniedServer.port}`]),
);
add(
  "net *: direct TCP allowed",
  true,
  await inSandbox({ net: ["*"] }, ["tcp", `127.0.0.1:${allowedServer.port}`]),
);

// sandbox_init_with_parameters through bun:ffi: the launcher confines itself.
const ffiProfile = join(scratch, "ffi.sb");
writeFileSync(
  ffiProfile,
  `(version 1)(allow default)(deny file-read* (subpath "${realpathSync(join(homedir(), ".ssh"))}"))`,
);
add(
  "ffi sandbox_init: ~/.ssh denied after init",
  false,
  await run([bun, join(here, "sandbox-init.ts"), ffiProfile, sshConfig]),
  (r) => r.detail.startsWith("sandbox_init=0") && r.detail.includes("EPERM"),
);

// Every granted capability is reported with its enforcer, none left unenforced.
const everything = Capabilities.parse({
  fs: { read: [join(scratch, "readable")], write: [join(scratch, "writable")] },
  net: ["allowed.test"],
  exec: ["/bin/ls"],
  pty: true,
  clipboard: { read: true, write: true },
  notify: true,
  openUrl: true,
  secrets: ["token"],
  inputGlobal: true,
  tabsMessage: true,
});
const { report, profile: sample } = profileFor(everything, runtime(proxy.port));
const reported = report.map((r) => r.capability).sort();
add("report: one line per granted capability, none unenforced", true, {
  ok:
    JSON.stringify(reported) === JSON.stringify(granted(everything).sort()) &&
    report.every((r) => r.by !== "unenforced"),
  detail: reported.join(","),
});

await proxy.stop();
void allowedServer.stop(true);
void deniedServer.stop(true);

async function median(argv: string[]) {
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    const p = Bun.spawn(argv, {
      stdout: "ignore",
      stderr: "ignore",
      env: { TMPDIR: join(scratch, "tmp"), HOME: homedir() },
    });
    await p.exited;
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return Math.round(times[Math.floor(RUNS / 2)] ?? 0);
}
const base = profileFor(Capabilities.parse({}), runtime()).profile;
const generation = performance.now();
for (let i = 0; i < RUNS; i++) profileFor(everything, runtime(proxy.port));
const timings = {
  runs: RUNS,
  profileGenerationMs: Number(((performance.now() - generation) / RUNS).toFixed(2)),
  bunE0: {
    bare: await median([bun, "-e", "0"]),
    sandboxed: await median(sandboxed(base, [bun, "-e", "0"])),
  },
  childBoot: {
    bare: await median(child(["boot"])),
    sandboxed: await median(sandboxed(base, child(["boot"]))),
  },
  ffiInit: {
    sandboxInitProcess: await median([
      bun,
      join(here, "sandbox-init.ts"),
      ffiProfile,
      join(scratch, "readable/data.txt"),
    ]),
  },
};

let linux: unknown = "not run (pass --linux; needs docker)";
if (process.argv.includes("--linux")) {
  const r = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--privileged",
      "-v",
      `${root}:/repo:ro`,
      "oven/bun:1.4.2",
      "sh",
      "-c",
      "apt-get update -qq >/dev/null && apt-get install -y -qq bubblewrap >/dev/null 2>&1; bun /repo/probes/sandbox/linux-run.ts",
    ],
    { encoding: "utf8", timeout: CONTAINER_TIMEOUT_MS },
  );
  try {
    linux = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    linux = { error: r.stderr.slice(-CONTAINER_ERROR_CHARS) };
  }
}

rmSync(scratch, { recursive: true, force: true });
const results = cases.map((c) => {
  const pass = c.check ? c.got.ok === c.expect && c.check(c.got) : c.got.ok === c.expect;
  return {
    name: c.name,
    expect: c.expect,
    ok: c.got.ok,
    pass,
    // Paths and the user's files stay out of the committed results.
    detail: (c.name.includes("without sandbox") && c.name.includes("ssh")
      ? "<file content>"
      : c.got.detail
    )
      .replaceAll(nonce, "<nonce>")
      .replaceAll(scratch, "$SCRATCH")
      .replaceAll(homedir(), "$HOME"),
  };
});
const output = {
  date: new Date().toISOString().slice(0, DATE_CHARS),
  macos: spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).stdout.trim(),
  darwin: release(),
  bun: Bun.version,
  passed: results.filter((r) => r.pass).length,
  total: results.length,
  cases: results,
  timings,
  report,
  sampleProfile: sample.replaceAll(scratch, "$SCRATCH").replaceAll(homedir(), "$HOME").split("\n"),
  linux,
};
writeFileSync(join(here, "results.json"), `${JSON.stringify(output, null, 2)}\n`);
for (const r of results)
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}  (${r.detail.slice(0, SUMMARY_CHARS)})`);
console.log(JSON.stringify(timings));
const linuxCases = LinuxSummary.safeParse(linux).data?.cases ?? [];
for (const c of linuxCases) console.log(`${c.pass ? "PASS" : "FAIL"}  linux: ${c.name}`);
if (results.some((r) => !r.pass) || linuxCases.some((c) => !c.pass)) process.exit(1);
