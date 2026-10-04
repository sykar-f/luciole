/**
 * Agent example on a real PTY, against the real pi and model (spends a little quota).
 *
 * Journey: `luciole dev` → pi boots → prompt with write + bash tool calls streamed → the file
 * exists in the sandbox → browse and unfold the calls → a long bash call interrupted with
 * Ctrl+X → new session → quit, with no pi process left behind. Sandbox and state live in a
 * temporary directory. AGENT_MODEL / AGENT_THINKING pass through; AGENT_PTY_FRAMES=<dir>
 * writes each screen there.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ctrl, drive, Keys } from "./driver";
import {
  BUN,
  CLI,
  commandOutput,
  defer,
  eventually,
  example,
  report,
  temporaryDirectory,
  workingIn,
} from "./harness";

const FRAMES = process.env.AGENT_PTY_FRAMES;
const BOOT_TIMEOUT_MS = 60_000;
const MODEL_TIMEOUT_MS = 90_000;
const TIMEOUT_MS = 30_000;
const TENTHS = 10;
const seconds = (ms: number) => Math.round(ms / (1000 / TENTHS)) / TENTHS;

using directory = temporaryDirectory("luciole-agent-");
const sandbox = join(directory.path, "sandbox");
/** pi renames its process to "pi" (argv is hidden): found by its working directory. */
const piProcesses = () =>
  existsSync(sandbox)
    ? workingIn(commandOutput(["pgrep", "-x", "pi"]).split(/\s+/).filter(Boolean), sandbox).map(
        Number,
      )
    : [];
await using _pi = defer(() => {
  for (const pid of piProcesses()) process.kill(pid, "SIGKILL");
});
await using t = await drive({
  command: [BUN, CLI, "dev", "--app", example("agent")],
  cols: 120,
  rows: 40,
  env: { AGENT_CWD: sandbox, XDG_STATE_HOME: join(directory.path, "state") },
  settle: 300,
});
const frame = async (name: string) => {
  if (!FRAMES) return;
  mkdirSync(FRAMES, { recursive: true });
  await Bun.write(join(FRAMES, `${name}.txt`), await t.snapshot());
};
const timings: Record<string, number> = {};

await t.waitFor("No messages yet", { timeout: BOOT_TIMEOUT_MS });
await t.waitFor("● idle", { timeout: TIMEOUT_MS });
assert.ok((await t.text()).includes(sandbox), "the working directory is shown");
assert.ok(piProcesses().length > 0, "pi runs");
await frame("1-idle");

let start = performance.now();
await t.type(
  "Create notes.txt containing the word luciole, then run `wc -c notes.txt` " +
    "with bash. Reply in one short sentence.",
);
await t.type(Keys.enter);
await t.waitFor("running");
await t.waitFor("✎ write", { timeout: MODEL_TIMEOUT_MS });
await t.waitFor("$ bash", { timeout: MODEL_TIMEOUT_MS });
await t.waitFor("● idle", { timeout: MODEL_TIMEOUT_MS });
timings.firstPromptSeconds = seconds(performance.now() - start);
assert.equal(
  readFileSync(join(sandbox, "notes.txt"), "utf8").trim(),
  "luciole",
  "the tool ran in the sandbox",
);
assert.ok((await t.text()).includes("wc -c notes.txt"));
await frame("2-answered");

// Browse: Esc selects the last call (bash); Enter unfolds its output.
await t.type(Keys.escape);
await t.waitFor("fold all", { timeout: TIMEOUT_MS });
await t.type(Keys.enter);
await t.waitFor("▾ $ bash", { timeout: TIMEOUT_MS });
assert.match(await t.text(), /│\s+\d+ notes\.txt/, "the bash output is unfolded");
await t.type("a", 500);
await t.waitFor("+ luciole", { timeout: TIMEOUT_MS });
await frame("3-unfolded");
await t.type("a");
await t.waitFor("+ luciole", { timeout: TIMEOUT_MS, absent: true });
await t.type("i");
await t.waitFor("browse tools", { timeout: TIMEOUT_MS });

// Interrupt a long call; the transcript records it and pi settles.
await t.type("Run `sleep 30` with bash, then say done.");
await t.type(Keys.enter);
// The call itself is running (its header, with a clock), not just the model.
await t.waitFor(/\$ bash sleep 30 +running \d/, { timeout: MODEL_TIMEOUT_MS });
await frame("4-running");
start = performance.now();
await t.type(ctrl("x"));
await t.waitFor("Interrupted", { timeout: TIMEOUT_MS });
await t.waitFor("● idle", { timeout: TIMEOUT_MS });
timings.interruptSeconds = seconds(performance.now() - start);
await frame("5-interrupted");

// New session: asks for confirmation, then empties the transcript.
await t.type(ctrl("n"));
await t.waitFor("Ctrl+N again", { timeout: TIMEOUT_MS });
await t.type(ctrl("n"));
await t.waitFor("No messages yet", { timeout: TIMEOUT_MS });
await frame("6-new-session");

await t.quit(ctrl("c"));
assert.ok(await eventually(() => piProcesses().length === 0), "pi outlived the Server");
report({
  agentPTY: true,
  toolCallsStreamed: ["write", "bash"],
  fileWrittenInSandbox: true,
  unfoldedOutput: true,
  interrupted: true,
  newSession: true,
  terminalRestored: true,
  noOrphanPi: true,
  ...timings,
});
