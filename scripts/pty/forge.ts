/**
 * Forge production smoke: built artefacts, separate Server and Client processes, real PTY.
 *
 * Journey: sign in → repository → pull request → approve → comment → files → $EDITOR
 * → live checks → merge → quit. Runs under simulated latency (LUCIOLE_LATENCY_MS, default
 * 500) and measures that typing stays local. Observes PTY output, not photons. Writes
 * docs/forge-pty-frame.txt.
 */
import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ctrl, drive, Keys } from "./driver";
import {
  BUN,
  ROOT,
  build,
  example,
  numberFromEnv,
  report,
  startServer,
  temporaryDirectory,
} from "./harness";

const APP = example("forge");
const LATENCY_MS = numberFromEnv("LUCIOLE_LATENCY_MS", 500);
// 22 days after the seed's epoch (server/seed.ts, 2026-09-01T09:00Z): the Server's clock
// starts there, so the ages in docs/forge-pty-frame.txt do not change with the day of the run.
const CLOCK_START = "2026-09-23T09:00:00Z";

build(APP);
using directory = temporaryDirectory("forge-pty-");
await using server = await startServer(APP, {
  FORGE_DB: join(directory.path, "forge.sqlite"),
  FORGE_SLOW_MS: "150",
  FORGE_CI_SCALE: "0.2",
  FORGE_CLOCK_START: CLOCK_START,
});
// A stand-in for $EDITOR: it draws on the terminal Forge hands over, reads what the user
// types there, and records it with the process that started it.
const editor = join(directory.path, "fake-editor");
const marker = join(directory.path, "editor-marker");
writeFileSync(
  editor,
  "#!/bin/sh\n" +
    "for last; do :; done\n" +
    'printf "FAKE EDITOR %s\\n" "$(basename "$last")"\n' +
    "IFS= read -r typed\n" +
    `echo "$PPID $typed" > "${marker}"\n`,
);
chmodSync(editor, 0o755);
await using t = await drive({
  command: [BUN, join(APP, ".luciole/client/index.js"), "--url", server.url],
  cols: 140,
  rows: 40,
  env: {
    NODE_ENV: "production",
    VISUAL: "",
    EDITOR: editor,
    XDG_STATE_HOME: join(directory.path, "state"),
  },
  settle: 120,
});
const results: Record<string, unknown> = { productionPTY: true, simulatedRTTMs: LATENCY_MS };

await t.waitFor("Demo accounts");
await t.type("alice\r");
await t.type("forge\r");
await t.waitFor("@alice · maintainer");
await t.waitFor("RECENT ACTIVITY");

await t.type("1");
await t.waitFor("open pull request(s)");
await t.type("/");
await t.type("idempotency");
await t.escape();
let start = performance.now();
t.write(Keys.enter);
await t.waitFor("[m] merge");
results.openPullRequestMs = Math.round(performance.now() - start);

await t.type("a");
await t.waitFor("Approvals: @alice");
await t.type("c");
start = performance.now();
t.write("S");
const typed = Math.round((await t.waitFor("Unsaved Draft")) - start);
results.typingToPTYOutputMs = typed;
// The claim: typing in the editor is drawn before one simulated round trip.
assert.ok(typed < LATENCY_MS, JSON.stringify(results));
await t.type("hip it");
await t.type(ctrl("s")); // publishes; typing continues meanwhile
await t.waitFor("Ship it");
await t.escape();

await t.type(Keys.tab);
await t.waitFor("src/ledger.ts");
await t.type("]");
await t.type("]");
await t.waitFor("src/refunds.ts · typescript");
// e: the renderer hands the terminal to the editor, then takes it back.
await t.type("e");
await t.waitFor("FAKE EDITOR refunds@r1");
// Keys that are Forge commands (i inbox, e editor) go to the editor, not to Forge.
await t.type("i typed in the editor\r");
await t.waitFor("Viewed refunds@r1");
const recorded = readFileSync(marker, "utf8").trim();
assert.equal(recorded, `${t.pid} i typed in the editor`);
results.editorOnClient = true;
await t.type(Keys.tab);
await t.waitFor("log complete");
await t.type(Keys.tab);
await t.waitFor("Ready to merge");
await t.type("m");
await t.waitFor("Merged #1 into main");
await t.waitFor("Merged by @alice");
await Bun.write(join(ROOT, "docs/forge-pty-frame.txt"), await t.snapshot());

await t.quit();
report({
  ...results,
  journey: "login → approve → comment → files → editor → checks → merge",
  terminalRestored: true,
});
