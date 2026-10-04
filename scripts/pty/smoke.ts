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
import { ctrl, drive } from "./driver";
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
/** Lets a key's effect (Ctrl+E focusing the text) land before the next keys arrive. */
const KEY_SETTLE_MS = 150;
/** How long a lost connection goes unmentioned (StatusLine's LOST_QUIET_MS). */
const QUIET_MS = 3000;
let lossShownMs: number | undefined;

using directory = temporaryDirectory("luciole-pty-");
await using server = args.url
  ? undefined
  : await startServer(join(ROOT, "examples/notes"), {
      NOTES_DB: join(directory.path, "notes.sqlite"),
      NOTES_DELAY_MS: String(serverDelay),
      // Saves only when asked: the journey times its own save.
      NOTES_AUTOSAVE_MS: "0",
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

/** The rows of the window's frame: search box, the list's count. */
async function layoutRows() {
  const lines = await t.lines();
  return [/⌕/, /^\s*\d+ notes\b/].map((marker) => lines.findIndex((line) => marker.test(line)));
}

// Everything by pointing, as a user who was never told a key.
await t.waitFor("Welcome to Notes");
const navigationStart = performance.now();
await t.click("Welcome to Notes");
let loadingMs: number | undefined;
let loadingRows: number[] | undefined;
if (latency >= VISIBLE_LOADING_RTT_MS) {
  loadingMs = (await t.waitFor("Loading the note…")) - navigationStart;
  // The claim: the loading state shows before one round trip ends, not after it.
  assert.ok(loadingMs < latency * 0.8, `loading shown after ${loadingMs} ms`);
  loadingRows = await layoutRows();
}
await t.waitFor("Getting around");
if (loadingRows) assert.deepEqual(await layoutRows(), loadingRows, "the loading layout moved");
// Ctrl+E: the cursor at the end of the text, where a click there would put it.
await t.type(ctrl("e"), KEY_SETTLE_MS);
t.write("abc");
await t.waitFor("abc");
// Autosave is off: unsaved text is marked until Ctrl+S sends it, then nothing is said.
await t.waitFor("● Unsaved");
t.write(ctrl("s"));
await t.waitFor("● Unsaved", { absent: true });
const start = performance.now();
t.write("d");
const localMs = (await t.waitFor("abcd")) - start;
// The claim: a keystroke shows while the save (NOTES_DELAY_MS) is still in flight.
assert.ok(localMs < 500, `typing reached the PTY after ${localMs} ms`);
// Saved "abc"; the "d" typed meanwhile is the Draft's, still to save.
await t.waitFor("● Unsaved");
assert.ok((await t.text()).includes("abcd"));
// Another note (the "+" beside the search), then back: the Draft outlived its editor.
await t.click("│ + │");
await t.waitFor("Untitled");
await t.click("Welcome to Notes");
await t.waitFor("abcd");
await t.waitFor("● Unsaved");
if (server) {
  await server.stop();
  t.write(ctrl("r"));
  const lost = performance.now();
  // Said once it lasts, over the page's own words, and about the text not yet saved.
  lossShownMs = (await t.waitFor("Disconnected")) - lost;
  // The claim: a short loss goes unmentioned; load can only make it later.
  assert.ok(lossShownMs >= QUIET_MS - 100, `lost connection said after ${lossShownMs} ms`);
  await t.waitFor("Reconnect");
  await t.type(ctrl("e"), KEY_SETTLE_MS);
  t.write("e");
  await t.waitFor("abcde");
  // Saving with the Server gone: refused, retried quietly, the text still there.
  t.write(ctrl("s"));
  await t.pause(QUIET_MS);
  const shown = await t.text();
  assert.ok(shown.includes("Your text is kept here") && shown.includes("abcde"), shown);
}
await Bun.write(join(ROOT, "docs/pty-frame.txt"), await t.snapshot());
if (server) {
  // A failed navigation reports its error in the page slot, with a button to try again;
  // no console overlay covers the UI.
  await t.click("Shopping list");
  await t.waitFor("Try again");
  await t.pause(200);
  const shown = await t.text();
  assert.ok(shown.includes("⌕") && !shown.includes("Console"), shown);
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
  connectionLossShownAfterMs: lossShownMs === undefined ? null : round(lossShownMs),
  terminalRestored: true,
  transport: args.url ? "external Server (topology supplied by caller)" : "loopback",
  physicalDisplayLatencyMeasured: false,
});

function round(ms: number) {
  return Math.round(ms * 100) / 100;
}
