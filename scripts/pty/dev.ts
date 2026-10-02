/**
 * `luciole dev` on a PTY: a compiler failure is displayed inside the still-editable Client;
 * a valid rebuild reopens the page with its named fields; shutdown reaps both children.
 */
import assert from "node:assert/strict";
import { cpSync, existsSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ctrl, drive } from "./driver";
import {
  alive,
  BUN,
  CLI,
  commandOutput,
  eventually,
  example,
  report,
  ROOT,
  temporaryDirectory,
} from "./harness";

/** Lets a key's effect (Ctrl+E focusing the text) land before the next keys arrive. */
const KEY_SETTLE_MS = 150;

const TIMEOUT_MS = 20_000;

using directory = temporaryDirectory("luciole-dev-");
const app = join(directory.path, "app-source");
cpSync(example("notes"), app, {
  recursive: true,
  filter: (source) => basename(source) !== ".luciole" && !basename(source).includes(".sqlite"),
});
// Outside the workspace the copy resolves nothing: Notes imports workspace packages
// (@luciole-sh/markdown-editor, @luciole-sh/core/math) that only its node_modules link.
symlinkSync(join(ROOT, "node_modules"), join(app, "node_modules"), "dir");
const sessions = join(directory.path, "state/luciole/app-source/sessions");
await using t = await drive({
  command: [BUN, CLI, "dev", "--app", app],
  cols: 140,
  // Tall enough for the whole note: the build error's banner pushes the screen down.
  rows: 40,
  env: {
    NOTES_DB: join(directory.path, "notes.sqlite"),
    // Nothing saves by itself: the typed text is still unsaved when the rebuild restores it.
    NOTES_AUTOSAVE_MS: "0",
    XDG_STATE_HOME: join(directory.path, "state"),
  },
});
const children = () =>
  commandOutput(["pgrep", "-P", String(t.pid)])
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
const wait = (text: string) => t.waitFor(text, { timeout: TIMEOUT_MS });

await wait("Welcome to Notes");
await t.click("Welcome to Notes");
await wait("Getting around");
// Ctrl+E: the cursor at the end of the text.
await t.type(ctrl("e"), KEY_SETTLE_MS);
// On a line of its own: the end of the note would wrap it.
t.write("\rkeep");
await wait("keep");
const first = children();
assert.equal(first.length, 2, `dev runs a Server and a Client: ${first.join()}`);
const page = join(app, "app/page.tsx");
const original = readFileSync(page, "utf8");
writeFileSync(page, 'export default async function Page(){"use server";return <text>bad</text>}');
await wait("Build failed:");
t.write("!");
await wait("keep!");
// The restarted Client reopens the note, and the text typed in its named field.
writeFileSync(page, original + "\n// valid rebuild\n");
let second: number[] = [];
assert.ok(
  // Between the two generations pgrep finds no child.
  await eventually(() => {
    second = children();
    return second.length === 2 && !second.some((pid) => first.includes(pid));
  }, TIMEOUT_MS),
  "the rebuild never restarted both children",
);
// Only the new Client draws from here on: the note and its typed text come back.
t.resetScreen();
await wait("● Unsaved");
await wait("keep!");
await t.quit();
assert.ok(
  !existsSync(sessions) || !readdirSync(sessions).some((name) => name.endsWith(".json")),
  "a quit session was kept",
);
for (const pid of [...first, ...second]) assert.ok(!alive(pid), `orphan process ${pid}`);

report({
  devPTY: true,
  buildErrorShown: true,
  typingAfterBuildError: true,
  successfulRebuildRestarts: true,
  rebuildRestoresPageAndFields: true,
  quitDeletesSession: true,
  terminalRestored: true,
  noOrphanChildren: true,
});
