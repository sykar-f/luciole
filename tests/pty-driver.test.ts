import { expect, test } from "bun:test";
import { drive } from "../scripts/pty/driver";
import { eventually } from "../scripts/pty/harness";

/** A Bun program on the PTY, from its source. */
const program = (source: string) => [process.execPath, "-e", source];

test("the driver answers the terminal queries a Client waits on, then gives the terminal back", async () => {
  await using t = await drive({
    command: program(`
      process.stdin.setRawMode(true);
      let answers = "";
      process.stdin.on("data", (bytes) => {
        answers += bytes.toString("latin1");
        if (!answers.endsWith("c")) return;
        process.stdout.write("answers " + JSON.stringify(answers) + "\\r\\n");
        process.stdin.setRawMode(false);
        process.exit(0);
      });
      process.stdout.write("\\x1b[6n\\x1b[c");
    `),
    cols: 60,
    rows: 5,
  });
  await t.waitFor("answers");
  expect(await t.text()).toContain(String.raw`answers "\u001b[1;1R\u001b[?1;2c"`);
  expect(await t.exited()).toBe(0);
  t.assertRestored();
});

test("a wait ends on a complete synchronized frame drawn after the last key", async () => {
  // A frame per key, its end written apart from its start.
  await using t = await drive({
    command: program(`
      process.stdin.setRawMode(true);
      let count = 0;
      const draw = () => {
        process.stdout.write("\\x1b[?2026h\\x1b[H\\x1b[2Kcount " + count);
        setTimeout(() => process.stdout.write(" drawn\\x1b[?2026l"), 150);
      };
      draw();
      process.stdin.on("data", () => ((count += 1), draw()));
    `),
    cols: 40,
    rows: 3,
  });
  await t.waitFor("count");
  expect(await t.text()).toContain("count 0 drawn");
  t.write("x");
  // "count" is already shown: the wait still needs the frame the key caused.
  await t.waitFor("count");
  expect(await t.text()).toContain("count 1 drawn");
});

test("an editor handoff accepts plain output and reentry restores frame gating", async () => {
  await using t = await drive({
    command: program(`
      process.stdin.setRawMode(true);
      process.stdout.write("\\x1b[?1049h\\x1b[?2026hrenderer ready\\x1b[?2026l");
      process.stdin.on("data", (bytes) => {
        for (const key of bytes.toString()) {
          if (key === "e") process.stdout.write("\\x1b[?1049l\\x1b[H\\x1b[2Jeditor ready");
          if (key === "r") process.stdout.write("\\x1b[?1049hresumed pending");
          if (key === "f") process.stdout.write("\\x1b[?2026hrenderer pending");
          if (key === "c") process.stdout.write(" complete\\x1b[?2026l");
        }
      });
    `),
    cols: 60,
    rows: 5,
  });
  await t.waitFor("renderer ready");
  // No synchronized frame follows this input: the editor writes only plain text.
  t.write("e");
  await t.waitFor("editor ready", { timeout: 500 });
  expect(await t.text()).toContain("editor ready");

  t.write("r");
  expect(await eventually(() => t.output().includes("resumed pending"))).toBe(true);
  // Reentry needs a new complete frame, even before the renderer begins one.
  const resumed = t.waitFor("resumed pending", { timeout: 100 });
  expect(resumed).rejects.toThrow("never showed");
  await resumed.catch(() => {});
  t.write("f");
  expect(await eventually(() => t.output().includes("renderer pending"))).toBe(true);
  const incomplete = t.waitFor("renderer pending", { timeout: 100 });
  expect(incomplete).rejects.toThrow("never showed");
  await incomplete.catch(() => {});
  t.write("c");
  await t.waitFor("renderer pending complete");
});

test("renderer reentry cannot reuse a frame completed before suspension", async () => {
  await using t = await drive({
    command: program(`
      process.stdin.setRawMode(true);
      process.on("SIGUSR1", () => process.stdout.write("\\x1b[?1049hresumed pending"));
      process.stdin.on("data", () => process.stdout.write("\\x1b[?2026h complete\\x1b[?2026l"));
      process.stdout.write("\\x1b[?1049h\\x1b[?2026hrenderer ready\\x1b[?2026l\\x1b[?1049leditor ready");
    `),
    cols: 60,
    rows: 5,
  });
  await t.waitFor("editor ready");
  // A program may resume by itself, without a key changing the driver's input mark.
  t.signal("SIGUSR1");
  expect(await eventually(() => t.output().includes("resumed pending"))).toBe(true);
  const stale = t.waitFor("resumed pending", { timeout: 100 });
  expect(stale).rejects.toThrow("never showed");
  await stale.catch(() => {});
  t.write("c");
  await t.waitFor("resumed pending complete");
});

test("a resize reaches the program, and a failed wait shows the screen", async () => {
  await using t = await drive({
    command: [
      "sh",
      "-c",
      "trap 'echo \"size $(stty size)\"' WINCH; echo ready; while :; do sleep 0.05; done",
    ],
    cols: 40,
    rows: 10,
  });
  await t.waitFor("ready");
  t.resize(30, 8);
  await t.waitFor("size 8 30");
  const failure = t.waitFor("never shown", { timeout: 100 });
  expect(failure).rejects.toThrow(/never showed "never shown"[\s\S]*ready/);
  await failure.catch(() => {});
});

test("a hangup reaches the program's whole session", async () => {
  await using t = await drive({
    command: ["sh", "-c", "trap 'exit 7' HUP; echo ready; while :; do sleep 0.05; done"],
    cols: 40,
    rows: 5,
  });
  await t.waitFor("ready");
  t.hangup();
  expect(await t.exited()).toBe(7);
});

test("a program that leaves the terminal raw is caught", async () => {
  await using t = await drive({ command: ["sh", "-c", "stty raw -echo"], cols: 40, rows: 5 });
  expect(await t.exited()).toBe(0);
  expect(() => t.assertRestored()).toThrow("terminal attributes not restored");
});
