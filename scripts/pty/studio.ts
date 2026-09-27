/**
 * The studio example on a real PTY, on its scripted generator (offline, no quota):
 * `airtty dev -- --harness fake --dir <project>` → the template runs in the preview →
 * Ctrl+O o gives the keys to the app, whose counter goes through its (confined) Server
 * into data/ → a prompt becomes revision r1, the counter kept → a command the generator
 * asks for is refused by studio's policy → a package outside the allowed ones is refused
 * by the guard, then corrected → Ctrl+C quits, nothing left running.
 * STUDIO_PTY_FRAMES=<dir> writes each screen there.
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

const FRAMES = process.env.STUDIO_PTY_FRAMES;
const BOOT_TIMEOUT_MS = 90_000;
const TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 10_000;
const PROCESS_EXIT_TIMEOUT_MS = 8000;

using directory = temporaryDirectory("airtty-studio-");
const project = join(directory.path, "demo");
/** Everything this journey started that runs from the project (preview Servers, Clients). */
const running = () => commandOutput(["pgrep", "-f", project]).split(/\s+/).filter(Boolean);
/** This journey's studio Server: found by the project it was given. */
const studioServers = () =>
  commandOutput(["pgrep", "-f", `${example("studio")}/.airtty/server/index.js`])
    .split(/\s+/)
    .filter(Boolean);
await using t = await drive({
  command: [
    BUN,
    CLI,
    "dev",
    "--app",
    example("studio"),
    "--",
    "--harness",
    "fake",
    "--dir",
    project,
  ],
  cols: 160,
  rows: 44,
  cwd: directory.path,
  env: {
    XDG_STATE_HOME: join(directory.path, "state"),
    XDG_DATA_HOME: join(directory.path, "data"),
    STUDIO_FAKE_DELAY_MS: "5",
  },
  settle: 300,
});
const frame = async (name: string) => {
  if (!FRAMES) return;
  mkdirSync(FRAMES, { recursive: true });
  await Bun.write(join(FRAMES, `${name}.txt`), await t.snapshot());
};
const wait = (needle: string | RegExp) => t.waitFor(needle, { timeout: TIMEOUT_MS });
const prompt = async (text: string) => {
  await t.type(text);
  await t.type(Keys.enter);
};

// r0, the template, runs in the preview.
await t.waitFor("describe the app you want", { timeout: BOOT_TIMEOUT_MS });
await wait(/r0 · (sandbox|process)/);
assert.ok(running().length > 0, "the preview's processes are found by the project path");
await frame("1-template");

// The keys go to the app: its counter, through its Server, into data/.
await t.type(ctrl("o"));
await t.type("o");
await t.type("+");
await wait("Count: 1");
await t.type(ctrl("o"));
await t.type("o");
await frame("2-counter");

await prompt("Change the greeting to 'Hello from studio'");
await wait("Revision r1 built and running.");
await wait(/ r1 · (sandbox|process) /);
// A new revision, a new Server: the data stayed.
await wait("Count: 1");
await frame("3-revision");

await prompt("Run the tests first, then change the greeting");
await wait("The command was refused");
await wait("Revision r2 built and running.");

await prompt("Format the count with thousands separators");
await wait("studio refused some changes");
await wait("Revision r3 built and running.");
await frame("4-guarded");

await t.quit(ctrl("c"), EXIT_TIMEOUT_MS);
assert.ok(
  await eventually(
    () => running().length === 0 && studioServers().length === 0,
    PROCESS_EXIT_TIMEOUT_MS,
  ),
  `processes outlived studio: ${running().join(" ")}`,
);
report({
  studioPTY: true,
  templatePreview: true,
  keysToTheApp: true,
  dataKeptAcrossRevisions: true,
  commandRefused: true,
  guardRefusedThenCorrected: true,
  terminalRestored: true,
  noOrphan: true,
});
