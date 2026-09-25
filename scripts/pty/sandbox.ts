/**
 * `airtty http://…` on a real PTY: the application runs sandboxed.
 *
 * Journey, offline and on private XDG directories: a publisher key, mdreader built with a
 * signed bundle, its Server on a local port → without a terminal to confirm on, nothing
 * opens → with --yes the capabilities screen says who enforces what (the Server's port by
 * the OS, nothing else granted), the key is pinned, the app runs in its own process, which
 * the kernel reports confined (Seatbelt on macOS; seccomp and no_new_privs on Linux), drawn
 * by the VT widget, and follows its keys → a second launch needs no question → Ctrl+C in
 * the app ends it, which closes its tab and the Client → --allow-read is granted,
 * remembered and shown as enforced by the OS → --inline switches the origin to inline.
 * On Linux the mechanism is what this system allows, or AIRTTY_SANDBOX_MECHANISM
 * (scripts/linux-sandbox.ts runs each); Landlock alone confines no network by host, so it
 * is never the default: the journey asks for it with --sandbox. Elsewhere: skipped, said so.
 */
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dlopen, FFIType } from "bun:ffi";
import { OriginRecord } from "../../packages/airtty/src/generic/origin";
import { sandboxAvailability } from "../../packages/airtty/src/sandbox/runtime";
import { ctrl } from "./driver";
import { airtty, build, commandOutput, defer, report, temporaryDirectory } from "./harness";
import { MDREADER, openByUrl, privateEnvironment, publish, startLibrary } from "./published";

/** Whether the kernel confines this process: Seatbelt on macOS, seccomp on Linux. */
function confined(pid: number) {
  if (process.platform === "darwin") {
    const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", {
      sandbox_check: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    });
    // No operation, no filter: 1 when the process runs under a sandbox profile.
    return symbols.sandbox_check(pid, null, 0) === 1;
  }
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  return status.includes("\nSeccomp:\t2\n") && status.includes("\nNoNewPrivs:\t1\n");
}

if (process.platform !== "darwin" && process.platform !== "linux") {
  console.log(JSON.stringify({ skipped: `no sandbox mode on ${process.platform}` }));
  process.exit(0);
}
// What this system allows (src/sandbox/mechanism.ts): nothing → said so, and skipped.
const availability = sandboxAvailability();
if (!availability.mechanism) {
  console.log(JSON.stringify({ skipped: `no sandbox mechanism here: ${availability.reason}` }));
  process.exit(0);
}
// Landlock alone is never the default for a URL: the user asks for it.
const explicit = process.env.AIRTTY_SANDBOX_MECHANISM === "landlock" ? ["--sandbox"] : [];

using directory = temporaryDirectory("airtty-pty-sandbox-");
const { env, docs } = privateEnvironment(directory.path, "sandbox");
const granted = join(directory.path, "granted");
mkdirSync(granted);
let server: Awaited<ReturnType<typeof startLibrary>> | undefined;
// The example keeps an unsigned build, as the repository expects.
await using _unsigned = defer(async () => {
  await server?.stop();
  build(MDREADER, [], env);
});
const fingerprint = publish(env, join(directory.path, "publisher"));
server = await startLibrary(env, docs);
const { url } = server;
const open = (...args: string[]) => openByUrl(url, args, env, directory.path);
/** The sandboxed Clients this journey started: one per application tab. */
const sandboxedChildren = () =>
  commandOutput(["ps", "-axo", "pid=,command="])
    .split("\n")
    .filter(
      (line) =>
        /^\s*\d+ \S*\/bun (--no-install )?\S*\/sandbox\/\.airtty\/child\.js --url /.test(line) &&
        line.includes(directory.path),
    );
const origin = () => {
  const origins = join(directory.path, "state/airtty/origins");
  const [first] = readdirSync(origins);
  return OriginRecord.parse(
    JSON.parse(readFileSync(join(origins, first ?? "", "origin.json"), "utf8")),
  );
};

// No terminal to confirm on: nothing of the application runs.
const refused = airtty([url, ...explicit], { env });
assert.ok(refused.exitCode !== 0 && refused.stderr.includes("not opened"), refused.stderr);
assert.ok(refused.stderr.includes("Sandbox ("), refused.stderr);

{
  // Sandboxed by default: the screen, the pinned key, the app in its own process.
  await using t = await open("--yes", ...explicit);
  await t.waitFor("alpha-sandbox");
  await t.waitFor("aucune capacité accordée");
  await t.waitFor("sandbox · ");
  await t.waitFor(`mdreader · ${url}`);
  const shown = t.output();
  assert.ok(shown.includes("Sandbox (") && shown.includes(fingerprint), shown.slice(0, 2000));
  assert.ok(shown.includes(`Server de l'app ${url} — `), shown.slice(0, 2000));
  assert.ok(shown.includes("Capacités accordées : aucune"));
  const children = sandboxedChildren();
  assert.equal(children.length, 1, JSON.stringify(children));
  // The kernel's word: the app's process runs confined.
  assert.ok(confined(Number(children[0]?.trim().split(/\s+/)[0])), "the app is not sandboxed");
  await t.type("["); // mdreader's key, through the VT widget to the sandboxed Client
  await t.waitFor("beta-sandbox");
  // Ctrl+C reaches the app, which quits: its tab closes, then the Client.
  await t.quit();
  assert.deepEqual(sandboxedChildren(), [], "the sandboxed Client outlived its tab");
}
let record = origin();
assert.equal(record.mode, "sandbox", JSON.stringify(record));
assert.equal(record.publisher?.fingerprint, fingerprint, JSON.stringify(record));

{
  // Remembered: no question; a flag grants more, shown with who enforces it.
  await using t = await open(`--allow-read=${granted}`, ...explicit);
  await t.waitFor("alpha-sandbox");
  await t.waitFor("fs.read (OS)");
  const shown = t.output();
  assert.ok(shown.includes(`fs.read ${granted} — OS (`), shown.slice(0, 2000));
  await t.type(ctrl("o"));
  await t.quit("q");
}
record = origin();
assert.deepEqual(record.granted?.fs.read, [granted], JSON.stringify(record));

{
  // Inline by explicit choice: asked once, then remembered.
  await using t = await open("--inline", "--yes");
  await t.waitFor("alpha-sandbox");
  await t.waitFor("inline · confiance totale");
  assert.deepEqual(sandboxedChildren(), []);
  await t.type(ctrl("o"));
  await t.quit("q");
}

report({
  productionPTY: true,
  refusedWithoutConfirmation: true,
  sandboxByDefault: true,
  capabilitiesScreenNamesEnforcers: true,
  appInSandboxedProcess: true,
  kernelReportsSandboxed: true,
  keysThroughVtWidget: true,
  ctrlCEndsChildAndTab: true,
  allowFlagRememberedAndShown: true,
  inlineByExplicitChoice: true,
  terminalRestored: true,
});
