import { expect, test } from "bun:test";
import { canGreet, mascotArt } from "../packages/luciole/src/mascot";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const TTY = { isTTY: true };
const TRUECOLOR = { COLORTERM: "truecolor" };

test("the mascot is about 20 terminal rows of at most 30 cells, without blank edges", () => {
  const lines = mascotArt().split("\n");
  expect(lines.length).toBeGreaterThanOrEqual(18);
  expect(lines.length).toBeLessThanOrEqual(21);
  expect(lines[0]?.trim()).not.toBe("");
  expect(lines.at(-1)?.trim()).not.toBe("");
  // Every visible character (▀, ▄, space) is one UTF-16 unit.
  for (const line of lines) expect(line.replace(ANSI, "").length).toBeLessThanOrEqual(30);
  // Its lantern is lit: some cells use the lantern's bright green.
  expect(mascotArt()).toMatch(/38;2;\d+;2[0-5]\d;/);
});

test("it greets only a person at a 24-bit colour terminal", () => {
  expect(canGreet(TTY, TRUECOLOR)).toBe(true);
  expect(canGreet(TTY, { COLORTERM: "24bit" })).toBe(true);
  expect(canGreet({ isTTY: false }, TRUECOLOR)).toBe(false);
  expect(canGreet({}, TRUECOLOR)).toBe(false);
  expect(canGreet(TTY, { ...TRUECOLOR, NO_COLOR: "1" })).toBe(false);
  expect(canGreet(TTY, { ...TRUECOLOR, CI: "true" })).toBe(false);
  expect(canGreet(TTY, {})).toBe(false);
});
