import { expect, test } from "bun:test";
import { isReply } from "../packages/airtty/src/web/replies";

const ESC = "\u001b";

test("a terminal's answers are told apart from what a hand typed", () => {
  // What xterm.js answered Notes with as it started, in the landing's hero.
  const answers = [
    `${ESC}]10;rgb:e8e8/e1e1/cfcf${ESC}\\`,
    `${ESC}]11;rgb:0707/0606/0404${ESC}\\`,
    `${ESC}[1;1R`,
    `${ESC}[?2026;2$y`,
    `${ESC}[?1;2c`,
    `${ESC}[>0;276;0c`,
    `${ESC}[0n`,
    `${ESC}[8;24;80t`,
    `${ESC}[?0u`,
  ];
  // Keys, a paste, the mouse and the focus: the reader's hands.
  const typed = [
    "a",
    "hello",
    "\r",
    "\u007f",
    `${ESC}`,
    `${ESC}[B`,
    `${ESC}OP`,
    `${ESC}[<0;10;5M`,
    `${ESC}[97;5u`,
    `${ESC}[I`,
  ];
  for (const answer of answers) expect(isReply(answer)).toBe(true);
  for (const data of typed) expect(isReply(data)).toBe(false);
});
