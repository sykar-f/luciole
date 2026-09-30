/** Formatting keys that reach an application in a terminal: Alt everywhere, Ctrl where told apart. */
import { expect, test } from "bun:test";
import { parseKeypress } from "@opentui/core";
import { intentOf } from "../src/view/keys.ts";

const ESC = "\u001b";
const intent = (sequence: string) => {
  const key = parseKeypress(sequence, { useKittyKeyboard: true });
  return key ? intentOf(key) : null;
};

test("Alt with a letter formats, links, copies; Alt with a digit sets the block", () => {
  expect(intent(`${ESC}b`)).toEqual({ type: "mark", mark: "bold" });
  expect(intent(`${ESC}i`)).toEqual({ type: "mark", mark: "italic" });
  expect(intent(`${ESC}s`)).toEqual({ type: "mark", mark: "strike" });
  expect(intent(`${ESC}e`)).toEqual({ type: "mark", mark: "code" });
  expect(intent(`${ESC}k`)).toEqual({ type: "link" });
  expect(intent(`${ESC}c`)).toEqual({ type: "copy" });
  expect(intent(`${ESC}2`)).toEqual({ type: "block", kind: { type: "heading", level: 2 } });
  expect(intent(`${ESC}0`)).toEqual({ type: "block", kind: { type: "paragraph" } });
  expect(intent(`${ESC}t`)).toEqual({ type: "task" });
});

test("Ctrl+B and Ctrl+K format; Ctrl+I only where the terminal tells it from Tab", () => {
  expect(intent("\u0002")).toEqual({ type: "mark", mark: "bold" });
  expect(intent("\u000b")).toEqual({ type: "link" });
  // Legacy Ctrl+I is Tab; the kitty protocol tells them apart.
  expect(intent("\t")).toEqual({ type: "tab", back: false });
  expect(intent(`${ESC}[105;5u`)).toEqual({ type: "mark", mark: "italic" });
});
