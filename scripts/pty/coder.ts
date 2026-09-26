/**
 * The coder example on a real PTY, on the scripted harness (offline, no quota):
 * `airtty dev -- --harness fake` → a streamed reply → a command → an edit approved in
 * its dialog → a slow command interrupted with Esc → Shift+Tab changes the mode → the
 * help overlay → browsing unfolds a block → Ctrl+C quits, the Server with it.
 * CODER_PTY_FRAMES=<dir> writes each screen there.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ctrl, drive, Keys } from "./driver";
import {
  BUN,
  CLI,
  commandOutput,
  eventually,
  example,
  report,
  temporaryDirectory,
  workingIn,
} from "./harness";

const FRAMES = process.env.CODER_PTY_FRAMES;
const BOOT_TIMEOUT_MS = 60_000;
const TIMEOUT_MS = 15_000;
const EXIT_TIMEOUT_MS = 10_000;
const SERVER_EXIT_TIMEOUT_MS = 5000;
const SHIFT_TAB = "\x1b[Z";

using directory = temporaryDirectory("airtty-coder-");
const project = join(directory.path, "project");
mkdirSync(project);
/** This journey's coder Servers: a coder the user runs elsewhere is not one of them. */
const servers = () =>
  workingIn(
    commandOutput(["pgrep", "-f", `${example("coder")}/.airtty/server/index.js`])
      .split(/\s+/)
      .filter(Boolean),
    project,
  );
await using t = await drive({
  command: [BUN, CLI, "dev", "--app", example("coder"), "--", "--harness", "fake"],
  cols: 120,
  rows: 36,
  cwd: project,
  env: { XDG_STATE_HOME: join(directory.path, "state"), CODER_FAKE_DELAY_MS: "5" },
  settle: 300,
});
const frame = async (name: string) => {
  if (!FRAMES) return;
  mkdirSync(FRAMES, { recursive: true });
  await Bun.write(join(FRAMES, `${name}.txt`), await t.snapshot());
};
const wait = (needle: string | RegExp, absent = false) =>
  t.waitFor(needle, { timeout: TIMEOUT_MS, absent });
const prompt = async (text: string) => {
  await t.type(text);
  await t.type(Keys.enter);
};

await t.waitFor("scripted demo is ready", { timeout: BOOT_TIMEOUT_MS });
// The Server is found by its directory: the check at the end is not vacuous.
assert.equal(servers().length, 1, "one coder Server runs in the project");
assert.ok((await t.text()).includes(project), "the project directory is shown");
assert.ok((await t.text()).includes("powered by scripted demo"));
await frame("1-ready");

await prompt("hello");
await wait("Ask me to run the tests");
await prompt("run the tests");
await wait("All 3 tests pass");
await wait("✓ exit 0");
await frame("2-command");

await prompt("edit greet");
await wait("allow once");
await frame("3-approval");
await t.type("y");
await wait("Done: greet now uses a template literal");
await wait("✎ src/greet.ts");
await frame("4-edited");

await prompt("slow please");
await wait(/waiting \d/);
await t.type(Keys.escape);
await wait("Interrupted");
await wait("exit 130");
await frame("5-interrupted");

await t.type(SHIFT_TAB);
await wait("auto edits");

await prompt("/help");
await wait("Keys and commands");
await t.type(Keys.escape);
await wait("Keys and commands", true);

// Browse: Ctrl+O selects the last foldable block; Enter unfolds it.
await t.type(ctrl("o"));
await wait("fold all");
await t.type(Keys.enter);
await wait("waiting 1");
await t.type("i");
await frame("6-browsed");

await t.quit(ctrl("c"), EXIT_TIMEOUT_MS);
assert.ok(
  await eventually(() => servers().length === 0, SERVER_EXIT_TIMEOUT_MS),
  "the coder Server outlived the Client",
);
report({
  coderPTY: true,
  streamedReply: true,
  command: true,
  approvalDialog: true,
  interrupted: true,
  modeChanged: true,
  helpOverlay: true,
  browsed: true,
  terminalRestored: true,
  noOrphanServer: true,
});
