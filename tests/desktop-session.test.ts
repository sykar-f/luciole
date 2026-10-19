/**
 * The desktop host's bridge between a PTY and a window's terminal view
 * (packages/desktop/src/host/session.ts), without Electrobun.
 */
import { expect, test } from "bun:test";
import { createWindowSession } from "../packages/desktop/src/host/session";
import { until } from "./helpers";
import { watchdogTest } from "./watchdog";

function open(script: string, env?: Record<string, string>) {
  let output = "";
  let exit: number | null | undefined;
  const session = createWindowSession({
    command: ["/bin/sh", "-c", script],
    env,
    send: (data) => {
      output += data;
    },
    onExit: (code) => {
      exit = code;
    },
  });
  session.open({ cols: 40, rows: 10 });
  return { session, output: () => output, exit: () => exit };
}

test("the program runs in desktop mode, at the view's size, and receives its input", async () => {
  watchdogTest("the program runs in desktop mode, at the view's size, and receives its input");
  const window = open('echo "$LUCIOLE_DESKTOP $(stty size)"; read line; echo "got $line"');
  await until(() => window.output().includes("1 10 40"));
  window.session.input("é\r");
  await until(() => window.output().includes("got é"));
  await until(() => window.exit() === 0);
});

test("the program is never told to act as Bun, as a single-runtime host is", async () => {
  watchdogTest("the program is never told to act as Bun, as a single-runtime host is");
  const window = open('echo "[${BUN_BE_BUN-unset}]"', { BUN_BE_BUN: "1" });
  await until(() => window.exit() !== undefined);
  expect(window.output()).toContain("[unset]");
});

test("a character split across reads reaches the view whole", async () => {
  watchdogTest("a character split across reads reaches the view whole");
  // "é" is two bytes; the program writes them apart.
  const window = open(String.raw`printf '\303'; sleep 0.2; printf '\251\n'`);
  await until(() => window.exit() !== undefined);
  expect(window.output()).toContain("é");
  expect(window.output()).not.toContain("�");
});

test("closing the window hangs the program up", async () => {
  watchdogTest("closing the window hangs the program up");
  const window = open("trap 'echo hung up; exit 7' HUP; echo ready; while :; do sleep 0.05; done");
  await until(() => window.output().includes("ready"));
  window.session.hangUp();
  await until(() => window.exit() !== undefined);
  expect(window.exit()).toBe(7);
});

for (const source of ["flag", "environment", "absent"] as const) {
  test(`desktop host relays pixel scroll from ${source}`, async () => {
    let output = "";
    let exit: number | null | undefined;
    const session = createWindowSession({
      command: ["/bin/sh", "-c", 'echo "pixel=[${LUCIOLE_PIXEL_SCROLL-unset}]"'],
      env: { LUCIOLE_PIXEL_SCROLL: source === "environment" ? "1" : undefined },
      pixelScroll: source === "flag",
      send: (data) => {
        output += data;
      },
      onExit: (code) => {
        exit = code;
      },
    });
    session.open({ cols: 40, rows: 10 });
    await until(() => exit !== undefined);
    expect(output).toContain(source === "absent" ? "pixel=[unset]" : "pixel=[1]");
  });
}
