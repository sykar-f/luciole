/**
 * coder on a real harness, on a real PTY (spends a little quota; manual, not in CI):
 *
 *   bun scripts/pty/coder-real.ts claude|codex|pi|opencode [model]
 *
 * The harness starts in a temporary project, answers a one-word prompt, writes a file
 * (through the approval dialog when it asks), then Ctrl+C quits and no harness process
 * is left.
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
} from "./harness";

const [harness = "claude", model] = process.argv.slice(2);
const FRAMES = process.env.CODER_PTY_FRAMES;
const BOOT_TIMEOUT_MS = 90_000;
const MODEL_TIMEOUT_MS = 120_000;

using directory = temporaryDirectory("luciole-coder-real-");
const project = join(directory.path, "project");
mkdirSync(project);
/** Processes working in the project directory: the harness and its tools. */
const inProject = () => commandOutput(["lsof", "-t", "+d", project]).split(/\s+/).filter(Boolean);
await using t = await drive({
  command: [
    BUN,
    CLI,
    "dev",
    "--app",
    example("coder"),
    "--",
    "-H",
    harness,
    ...(model ? ["-m", model] : []),
  ],
  cols: 120,
  rows: 36,
  cwd: project,
  env: { XDG_STATE_HOME: join(directory.path, "state") },
  settle: 300,
});
const frame = async (name: string) => {
  if (!FRAMES) return;
  mkdirSync(FRAMES, { recursive: true });
  await Bun.write(join(FRAMES, `${harness}-${name}.txt`), await t.snapshot());
};

await t.waitFor(/is ready in/, { timeout: BOOT_TIMEOUT_MS });
await frame("1-ready");
await t.type("Reply with exactly the word: pineapple");
await t.type(Keys.enter);
await t.waitFor("pineapple", { timeout: MODEL_TIMEOUT_MS });
await t.waitFor(/● \w/, { timeout: MODEL_TIMEOUT_MS });
await frame("2-answered");

await t.type("Create a file named hello.txt containing the word hi. Use your file-writing tool.");
await t.type(Keys.enter);
await frame("3-sent");
// Claude asks before writing in "ask" mode; Codex writes inside the workspace freely.
await t.waitFor(/allow once|✎ hello\.txt/, { timeout: MODEL_TIMEOUT_MS });
const asked = (await t.text()).includes("allow once");
if (asked) {
  await frame("4-approval");
  await t.type("y");
}
await t.waitFor("hello.txt", { timeout: MODEL_TIMEOUT_MS });
assert.ok(
  await eventually(() => Bun.file(join(project, "hello.txt")).size > 0, MODEL_TIMEOUT_MS),
  `the file was written:\n${await t.text()}`,
);
await frame("5-written");

await t.quit(ctrl("c"));
assert.ok(await eventually(() => inProject().length === 0), `${harness} outlived coder`);
report({
  harness,
  realPTY: true,
  answered: true,
  approvalDialog: true,
  fileWritten: true,
  noOrphan: true,
});
