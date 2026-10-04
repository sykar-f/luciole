/**
 * `luciole devtools` inspecting Notes under `luciole dev`, each on its own PTY.
 *
 * Checks what a developer would: both processes connect, requests appear with their Server
 * side, the component tree holds a Server Component, paint flashing reaches the
 * application's terminal, the Router panel invalidates a route in the application, network
 * conditions apply live, and Server logs arrive.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { drive, type Driver } from "./driver";
import { BUN, CLI, ROOT, report, temporaryDirectory } from "./harness";

const APP_START_TIMEOUT_MS = 60_000;
const SELECT_MS = 300;
/**
 * Paint flashing's outlines, bright then fading, for each heat (overlay.ts, COLOR): drawn
 * only by a flash. The selection's own outline, always there, has another color.
 */
const FLASH_COLORS = new Set([
  "#ff5f5f",
  "#8a3a3a",
  "#67d9bc",
  "#2f6b5c",
  "#f0c060",
  "#7a6431",
  "#ff8c42",
  "#7f4822",
]);
const OUTLINE = /[┌┐└┘─│]/;

using directory = temporaryDirectory("luciole-pty-devtools-");
const socket = `unix:${directory.path}/bus.sock`;
const env = { XDG_STATE_HOME: join(directory.path, "state") };
const size = { cols: 120, rows: 34 };
const wait = (t: Driver, text: string, timeout?: number) => t.waitFor(text, { timeout });
/** Whether a flash's outline is on the screen. */
const flashed = async (t: Driver) =>
  (await t.spans()).some((line) =>
    line.some((span) => FLASH_COLORS.has(span.fg) && OUTLINE.test(span.text)),
  );

await using devtools = await drive({
  command: [BUN, CLI, "devtools", "--listen", socket],
  ...size,
  cwd: ROOT,
  env,
});
await wait(devtools, "LUCIOLE_DEVTOOLS=");
await using app = await drive({
  command: [BUN, CLI, "dev", "--app", "examples/notes"],
  ...size,
  cwd: ROOT,
  env: {
    ...env,
    LUCIOLE_DEVTOOLS: socket,
    BUN_OPTIONS: `--preload=${ROOT}/packages/core/src/devtools/hook.ts`,
    NOTES_DB: join(directory.path, "notes.sqlite"),
  },
});
await wait(app, "Welcome to Notes", APP_START_TIMEOUT_MS);
await wait(devtools, "● client notes");
await wait(devtools, "● server notes");
// The first page: its row joins the Client's timings with the Server's.
await wait(devtools, "▣ /  ");
await wait(devtools, "Server: request +");

// Return opens the first note: a key never shown, for those who look for it.
app.write("\r");
await wait(app, "Getting around");
await wait(devtools, "▣ /notes/1");

devtools.write("2");
await wait(devtools, " components · ");
// The note's page comes after the list's rows, one per note: the selection walks down the
// tree, never further than it is long, until a component of NoteEditor.tsx shows.
for (let row = 0; ; row++) {
  const shown = await devtools.text();
  if (shown.includes("NoteEditor")) break;
  assert.ok(row < Number(/(\d+) components · /.exec(shown)?.[1]), shown);
  await devtools.type("j", SELECT_MS);
}
// The page above it, a Server Component.
await wait(devtools, "◇ ");
// Paint flashing: typing re-renders the editor, outlined in the application's terminal.
devtools.write("h");
await wait(devtools, "flashing in app");
// Return again edits the note; typing re-renders it.
app.write("\r");
app.write("x");
await app.until(() => flashed(app), "no paint flashing outline in the application");
devtools.write("h");

devtools.write("4");
await wait(devtools, "/notes/$id");
await devtools.type("G", SELECT_MS);
// The last match is the page: invalidating it renders it again, for that cause.
await devtools.type("k", SELECT_MS);
devtools.write("i");
devtools.write("1");
await wait(devtools, " inv ");

devtools.write("7");
await wait(devtools, "added latency");
devtools.write("m");
await wait(devtools, "Applied to 1 Client");

devtools.write("3");
await wait(devtools, '"ready":true');

report({
  devtoolsPTY: true,
  processesConnected: 2,
  serverTimingsJoined: true,
  serverComponentInTree: true,
  paintFlashingInApp: true,
  routerInvalidation: true,
  liveNetworkConditions: true,
  serverLogs: true,
});
