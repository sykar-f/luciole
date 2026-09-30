/**
 * The studio example on a real PTY, on its scripted generator (offline, no quota):
 * `luciole dev -- --harness fake --dir <project>` → the template runs in the preview →
 * Ctrl+O o gives the keys to the app, whose counter goes through its (confined) Server
 * into data/ → a prompt becomes revision r1, the counter kept → a command the generator
 * asks for is refused by studio's policy → a package outside the allowed ones is refused
 * by the guard, then corrected → a turn of several writes shows each one as a draft
 * before its revision → in the app's guestbook, a name and a message typed, the list
 * scrolled: the page, the text, the focus and the position survive a draft and a
 * revision → Ctrl+C quits, nothing left running. Then the same guestbook journey with
 * `--preview process`, where each Client reopens the project's session by its id.
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
// Room for each draft to build and draw before the next write: a Client in `process` mode
// takes 1.4–1.6 s to draw its first screen, one in the sandbox a few hundred ms.
const WRITE_MS = { sandbox: 3000, process: 6000 } as const;
// A Client that just drew its first screen, given a moment before it is sent keys.
const FIRST_KEYS_MS = 500;
// A restored scroll position waits for the list's rows: a moment after the page shows.
const KEPT_MS = 5000;
// Side by side at 160 columns, the preview's frame starts here: the transcript (which
// shows the diffs, the apps' texts included) stays left of it.
const PREVIEW_COLUMN = 80;

/** studio on its scripted generator, in a project of its own. */
async function launch(mode: keyof typeof WRITE_MS) {
  const directory = temporaryDirectory("luciole-studio-");
  const project = join(directory.path, "demo");
  const t = await drive({
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
      "--preview",
      mode,
    ],
    cols: 160,
    rows: 44,
    cwd: directory.path,
    env: {
      XDG_STATE_HOME: join(directory.path, "state"),
      XDG_DATA_HOME: join(directory.path, "data"),
      STUDIO_FAKE_DELAY_MS: "5",
      STUDIO_FAKE_WRITE_MS: String(WRITE_MS[mode]),
    },
    settle: 300,
  });
  /** Everything this journey started that runs from the project (preview Servers, Clients). */
  const running = () => commandOutput(["pgrep", "-f", project]).split(/\s+/).filter(Boolean);
  const frame = async (step: string) => {
    if (!FRAMES) return;
    mkdirSync(FRAMES, { recursive: true });
    await Bun.write(join(FRAMES, `${mode}-${step}.txt`), await t.snapshot());
  };
  const wait = (needle: string | RegExp) => t.waitFor(needle, { timeout: TIMEOUT_MS });
  const waitShown = (needle: string | RegExp) =>
    t.waitFor(inPreview(needle), { timeout: TIMEOUT_MS });
  const prompt = async (text: string) => {
    await t.type(text);
    await t.type(Keys.enter);
  };
  /** Ctrl+O o: the keys to the app, or back to the conversation. */
  const keys = async () => {
    await t.type(ctrl("o"));
    await t.type("o");
  };
  return {
    t,
    running,
    frame,
    wait,
    waitShown,
    prompt,
    keys,
    /** Ctrl+C quits studio: nothing it started outlives it, its Server included. */
    async quit() {
      await t.quit(ctrl("c"), EXIT_TIMEOUT_MS);
      assert.ok(
        await eventually(
          () => running().length === 0 && studioServers().length === 0,
          PROCESS_EXIT_TIMEOUT_MS,
        ),
        `processes outlived studio:\n${running()
          .map((pid) => commandOutput(["ps", "-o", "pid=,command=", "-p", pid]))
          .join("\n")}`,
      );
    },
    async [Symbol.asyncDispose]() {
      await t[Symbol.asyncDispose]();
      directory[Symbol.dispose]();
    },
  };
}
type Studio = Awaited<ReturnType<typeof launch>>;

/** This journey's studio Servers: found by the example's build. */
const studioServers = () =>
  commandOutput(["pgrep", "-f", `${example("studio")}/.luciole/server/index.js`])
    .split(/\s+/)
    .filter(Boolean);
/** The preview's half of the screen. */
const shown = (text: string) =>
  text
    .split("\n")
    .map((line) => line.slice(PREVIEW_COLUMN))
    .join("\n");
const inPreview = (needle: string | RegExp) => (text: string) =>
  typeof needle === "string" ? shown(text).includes(needle) : needle.test(shown(text));

/**
 * A turn of four writes followed as drafts, then, in the app's guestbook, a name, a
 * message and the list scrolled: all of it survives the drafts and the revision of the
 * next turn. `base` is the revision shown before. The times from each prompt to its first
 * draft shown (the generator writes within a few ms of the prompt).
 */
async function guestbook(studio: Studio, base: number) {
  const { t, wait, waitShown, prompt, keys, frame } = studio;
  const added = `r${base + 1}`;
  const counted = `r${base + 2}`;
  let asked = performance.now();
  await prompt("Add a guestbook page with a form to sign it");
  await waitShown("A guestbook is coming");
  const firstDraftMs = performance.now() - asked;
  await wait(/ draft · (sandbox|process)/);
  assert.ok(
    !(await t.text()).includes(`Revision ${added} built`),
    "the first write is shown while the turn goes on",
  );
  await frame("draft");
  await wait(`Revision ${added} built and running.`);
  await wait(new RegExp(` ${added} · (sandbox|process) `));
  await waitShown("g: the guestbook");
  await t.pause(FIRST_KEYS_MS);

  // In the app: the guestbook page, a name, then a message, the list scrolled by a page.
  await keys();
  await t.type("g");
  await waitShown("Guest 01:");
  await t.type("Ada");
  await t.type(Keys.tab);
  await t.type("Hi");
  await t.type(Keys.pageDown);
  await t.waitFor(
    (text) => !shown(text).includes("Guest 01:") && shown(text).includes("Guest 06:"),
    { timeout: TIMEOUT_MS },
  );
  await keys();
  await frame("guestbook");

  /** What the user was doing in the app: the page, both fields, the list's position. */
  const kept = async (when: string) => {
    const restored = (text: string) => {
      const preview = shown(text);
      return (
        preview.includes("Guest 06:") &&
        !preview.includes("Guest 01:") &&
        /Name\s+Ada/.test(preview) &&
        /Message\s+Hi/.test(preview)
      );
    };
    await t.waitFor(restored, { timeout: KEPT_MS }).catch((error: unknown) => {
      throw new Error(`${when}: the page, the fields or the list's position were lost`, {
        cause: error,
      });
    });
  };
  asked = performance.now();
  await prompt("Show how many people signed the guestbook");
  await waitShown("counting signatures");
  const secondDraftMs = performance.now() - asked;
  await wait(/ draft · (sandbox|process)/);
  await kept("after a draft");
  await wait(`Revision ${counted} built and running.`);
  await waitShown("30 signatures");
  await wait(new RegExp(` ${counted} · (sandbox|process) `));
  await kept("after a revision");
  // The focus stayed on the message: what is typed next goes there.
  await keys();
  await t.type("!");
  await waitShown(/Message\s+Hi!/);
  await keys();
  await frame("kept");
  return [Math.round(firstDraftMs), Math.round(secondDraftMs)];
}

await using studio = await launch("sandbox");
const { t, wait, prompt, keys, frame } = studio;
// r0, the template, runs in the preview.
await t.waitFor("describe the app you want", { timeout: BOOT_TIMEOUT_MS });
await wait(/r0 · (sandbox|process)/);
assert.ok(studio.running().length > 0, "the preview's processes are found by the project path");
await frame("1-template");

// The keys go to the app: its counter, through its Server, into data/.
await keys();
await t.type("+");
await wait("Count: 1");
await keys();
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

const sandboxDrafts = await guestbook(studio, 3);
await studio.quit();

// The same with the Clients unconfined: each one reopens the project's session by its id.
await using unconfined = await launch("process");
await unconfined.t.waitFor("describe the app you want", { timeout: BOOT_TIMEOUT_MS });
await unconfined.wait(/ r0 · process /);
const processDrafts = await guestbook(unconfined, 0);
await unconfined.quit();

report({
  studioPTY: true,
  templatePreview: true,
  keysToTheApp: true,
  dataKeptAcrossRevisions: true,
  commandRefused: true,
  guardRefusedThenCorrected: true,
  draftsDuringTheTurn: true,
  keptAcrossDraftAndRevision: ["page", "fields", "focus", "scroll"],
  // From the prompt to its first draft shown: the generator writes within a few ms.
  writeToDraftMs: { sandbox: sandboxDrafts, process: processDrafts },
  terminalRestored: true,
  noOrphan: true,
});
