/* eslint-disable no-magic-numbers -- Fixed cell geometry, colors and a bounded memory-growth proof. */
// This page is bundled against 0.6.6 sources; the repository's types stay pinned to 0.5.12.
import "../../packages/core/src/web/setup";
import { BoxRenderable, TextRenderable, StyledText, fg } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

type Cells = { char: Uint32Array; fg: Uint16Array };
function hasScopedBuffers(value: unknown): value is {
  withBuffers<T>(read: (cells: Cells) => T): T;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "withBuffers" in value &&
    typeof value.withBuffers === "function"
  );
}

async function check() {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 20,
    height: 5,
  });
  try {
    const box = new BoxRenderable(renderer, {
      id: "box",
      width: 12,
      height: 3,
      border: true,
      borderStyle: "single",
      borderColor: "#ff0000",
    });
    const text = new TextRenderable(renderer, { id: "text", content: "hello" });
    box.add(text);
    renderer.root.add(box);
    const read = () => {
      const buffer = renderer.currentRenderBuffer;
      if (!hasScopedBuffers(buffer)) throw new Error("0.6.6 scoped buffer access is missing");
      return buffer.withBuffers((cells) => ({
        cornerChar: String.fromCodePoint(cells.char[0]),
        textChars: Array.from(cells.char.slice(21, 26), (code) => String.fromCodePoint(code)).join(
          "",
        ),
        cornerFg: Array.from(cells.fg.slice(0, 4)),
        textFg: Array.from(cells.fg.slice(84, 88)),
        memory: cells.char.buffer,
        view: cells.char,
      }));
    };
    const frame = async (expected: string, color: number[]) => {
      // Transient FFI copies are released by a microtask before the next native read.
      await Promise.resolve();
      await renderOnce();
      const cells = read();
      const expectedLines = ["┌──────────┐", `│${expected}     │`, "└──────────┘"].map((line) =>
        line.padEnd(20),
      );
      const lines = captureCharFrame().split("\n");
      const ok =
        expectedLines.every((line, i) => lines[i] === line) &&
        cells.cornerChar === "┌" &&
        cells.textChars === expected &&
        JSON.stringify(cells.cornerFg) === JSON.stringify([255, 0, 0, 255]) &&
        JSON.stringify(cells.textFg) === JSON.stringify(color);
      if (!ok) throw new Error(`Incorrect frame for ${expected}: ${captureCharFrame()}`);
      return {
        text: expected,
        corner: cells.cornerChar,
        cornerFg: cells.cornerFg,
        textFg: cells.textFg,
        ok,
      };
    };
    const boxCells = await frame("hello", [255, 255, 255, 255]);
    const changedText = [];
    for (const value of ["first", "other", "final"]) {
      text.content = value;
      changedText.push(await frame(value, [255, 255, 255, 255]));
      text.content = new StyledText([fg("#00ff00")(value)]);
      changedText.push(await frame(value, [0, 255, 0, 255]));
    }
    const before = read();
    const bytesBefore = before.memory.byteLength;
    if (bytesBefore > 32 * 1024 * 1024) throw new Error("Unexpected baseline memory size");
    // One bounded text allocation larger than the entire current memory guarantees growth.
    // Keep it detached from the scene tree so layout never traverses the large text.
    const ballast = new TextRenderable(renderer, {
      id: "growth",
      content: "x".repeat(bytesBefore + 65_536),
      visible: false,
    });
    try {
      text.content = "grown";
      const cellsAfterGrowth = await frame("grown", [255, 255, 255, 255]);
      const bytesAfter = read().memory.byteLength;
      const detached = before.view.byteLength === 0;
      if (bytesAfter <= bytesBefore || !detached)
        throw new Error("The check did not grow WASM memory");
      return {
        boxCells,
        changedText,
        memoryGrowth: { bytesBefore, bytesAfter, detached, cellsAfterGrowth },
        ok: true,
      };
    } finally {
      ballast.destroy();
    }
  } finally {
    renderer.destroy();
  }
}
try {
  Object.assign(globalThis, { __opentui066: await check() });
} catch (error) {
  Object.assign(globalThis, { __opentui066: { ok: false, error: String(error) } });
}
