/**
 * Real production Client on a PTY: isolated DB, delayed Server, output observation (not
 * photon latency). Writes docs/pty-frame.txt.
 *   bun scripts/pty/smoke.ts [--url <Server>] [--client <client/index.js>]
 * With --url the Server is the caller's (another machine, a tunnel): the offline part,
 * which stops the Server, is skipped.
 */
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ctrl, drive, Keys } from "./driver";
import { BUN, ROOT, numberFromEnv, report, startServer, temporaryDirectory } from "./harness";

const { values: args } = parseArgs({
  options: {
    url: { type: "string" },
    client: { type: "string", default: "examples/notes/.luciole/client/index.js" },
  },
});
const latency = numberFromEnv("LUCIOLE_LATENCY_MS", 0);
const serverDelay = numberFromEnv("NOTES_DELAY_MS", 700);
// Under this simulated RTT the loading screen is too brief to be caught.
const VISIBLE_LOADING_RTT_MS = 400;

using directory = temporaryDirectory("luciole-pty-");
await using server = args.url
  ? undefined
  : await startServer(join(ROOT, "examples/notes"), {
      NOTES_DB: join(directory.path, "notes.sqlite"),
      NOTES_DELAY_MS: String(serverDelay),
      LUCIOLE_TEST: "1",
    });
const url = args.url ?? server?.url ?? "";
await using t = await drive({
  command: [BUN, resolve(ROOT, args.client), "--url", url],
  cols: 110,
  rows: 28,
  // A private state directory: the session file of this Client never reaches $HOME.
  env: { NODE_ENV: "production", XDG_STATE_HOME: join(directory.path, "state") },
});

/** The rows of the page's frame: title, box top and bottom, status line. */
async function layoutRows() {
  const lines = await t.lines();
  return ["Personal notebook", "┌", "└", "reconnect"].map((marker) =>
    lines.findIndex((line) => line.includes(marker)),
  );
}

await t.waitFor("First note");
const navigationStart = performance.now();
t.write(Keys.enter);
let loadingMs: number | undefined;
let loadingRows: number[] | undefined;
if (latency >= VISIBLE_LOADING_RTT_MS) {
  loadingMs = (await t.waitFor("Opening note 1")) - navigationStart;
  assert.ok(loadingMs < latency * 0.8, `loading shown after ${loadingMs} ms`);
  loadingRows = await layoutRows();
}
await t.waitFor("baseline:");
if (loadingRows) assert.deepEqual(await layoutRows(), loadingRows, "the loading layout moved");
t.write("abc");
await t.waitFor("abc");
t.write(Keys.enter);
await t.waitFor("Saving");
const start = performance.now();
t.write("d");
const localMs = (await t.waitFor("abcd")) - start;
assert.ok(localMs < 500, `typing reached the PTY after ${localMs} ms`);
await t.waitFor("baseline: abc");
assert.ok((await t.text()).includes("abcd"));
t.write(Keys.escape);
await t.waitFor("YOUR NOTES");
t.write(Keys.enter);
await t.waitFor("abcd");
// The reopened note may first show the router's cached version 1; the saved note is
// version 2 once revalidated. Waiting for it keeps docs/pty-frame.txt deterministic.
await t.waitFor("version 2");
if (server) {
  await server.stop();
  t.write(ctrl("r"));
  await t.waitFor("Disconnected");
  t.write("e");
  await t.waitFor("abcde");
}
await Bun.write(join(ROOT, "docs/pty-frame.txt"), await t.snapshot());
if (server) {
  // A failed navigation reports its error in the page slot; no console overlay covers the UI.
  t.write(Keys.escape);
  await t.waitFor("Ctrl+R to retry");
  await t.pause(200);
  const shown = await t.text();
  assert.ok(shown.includes("Personal notebook") && !shown.includes("Console"), shown);
}
await t.quit();

report({
  productionPTY: true,
  navigationLoadingToPTYOutputMs: loadingMs === undefined ? null : round(loadingMs),
  stableLoadingLayout: loadingRows !== undefined,
  saveWhileTyping: true,
  draftAcrossNavigation: true,
  typingToPTYOutputMs: round(localMs),
  simulatedRTTMs: latency,
  serverDelayMs: server ? serverDelay : "remote configuration",
  offlineEditing: Boolean(server),
  terminalRestored: true,
  transport: args.url ? "external Server (topology supplied by caller)" : "loopback",
  physicalDisplayLatencyMeasured: false,
});

function round(ms: number) {
  return Math.round(ms * 100) / 100;
}
