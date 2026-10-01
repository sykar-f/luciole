/** @jsxImportSource @opentui/react */
/**
 * What the web runtime tells the embedding page of the wheel (src/web/wheel-room.ts): over
 * each part of a screen, whether a turn still scrolls something, each way. Checked against
 * what OpenTUI then does with the turn: where the room says nothing moves, nothing does.
 */
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { RGBA, SyntaxStyle } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { MarkdownEditor } from "../packages/editor/src";
import { wheelRoom } from "../packages/luciole/src/web/wheel-room";

const WIDTH = 40;
const HEIGHT = 16;
const LIST = 4;
const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i}`);
const style = SyntaxStyle.fromStyles({ default: { fg: RGBA.fromHex("#e6edf3") } });

let ui: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(() => {
  ui?.renderer.destroy();
  ui = undefined;
});

/**
 * Row 0: a toolbar, nothing to scroll. Rows 1-4: a list of 12 in a scroll box. Row 5: a
 * text that fits. Rows 6-7: a canvas that pans on the wheel. Rows 8-15: an editor holding
 * 30 paragraphs.
 */
function Screen() {
  return (
    <box flexDirection="column" width={WIDTH} height={HEIGHT}>
      <box height={1}>
        <text>toolbar</text>
      </box>
      <scrollbox height={LIST} scrollY>
        {lines(12).map((line) => (
          <text key={line}>{line}</text>
        ))}
      </scrollbox>
      <box height={1}>
        <text>fits</text>
      </box>
      <box height={2} onMouseScroll={() => {}}>
        <text>canvas</text>
      </box>
      <MarkdownEditor
        value={lines(30).join("\n\n")}
        syntaxStyle={style}
        terminalBackground={RGBA.fromHex("#0d1117")}
        flexGrow={1}
      />
    </box>
  );
}

const TOOLBAR = { x: 2, y: 0 };
const LIST_ROW = { x: 2, y: 2 };
const FITS = { x: 2, y: 5 };
const CANVAS = { x: 2, y: 6 };
const EDITOR = { x: 2, y: 10 };

async function screen() {
  await act(async () => {
    ui = await testRender(<Screen />, { width: WIDTH, height: HEIGHT });
  });
  await ui?.renderOnce();
}
const screenShows = (text: string) => ui?.captureCharFrame().includes(text) === true;
const room = (at: { x: number; y: number }) => {
  if (!ui) throw new Error("no screen");
  return wheelRoom(ui.renderer, at.x, at.y);
};
/** Turns the wheel `times` over `at`; says whether the screen changed. */
async function turn(at: { x: number; y: number }, way: "up" | "down", times = 1) {
  if (!ui) throw new Error("no screen");
  const before = ui.captureCharFrame();
  for (let i = 0; i < times; i++)
    await act(async () => {
      await ui?.mockMouse.scroll(at.x, at.y, way);
    });
  await ui.renderOnce();
  return ui.captureCharFrame() !== before;
}

test("nothing under the pointer scrolls: no room either way, and a turn moves nothing", async () => {
  await screen();
  for (const at of [TOOLBAR, FITS]) {
    expect(room(at)).toEqual({ up: false, down: false });
    expect(await turn(at, "down")).toBe(false);
    expect(await turn(at, "up")).toBe(false);
  }
});

test("a scroll box has room down from its top, both ways in between, up at its end", async () => {
  await screen();
  expect(room(LIST_ROW)).toEqual({ up: false, down: true });
  expect(await turn(LIST_ROW, "up")).toBe(false);
  expect(await turn(LIST_ROW, "down")).toBe(true);
  expect(room(LIST_ROW)).toEqual({ up: true, down: true });
  await turn(LIST_ROW, "down", 20);
  expect(room(LIST_ROW)).toEqual({ up: true, down: false });
  expect(await turn(LIST_ROW, "down")).toBe(false);
});

test("the editor of @luciole/editor says its own room, past its last line by its tail", async () => {
  await screen();
  expect(room(EDITOR)).toEqual({ up: false, down: true });
  expect(await turn(EDITOR, "up")).toBe(false);
  expect(await turn(EDITOR, "down")).toBe(true);
  expect(room(EDITOR)).toEqual({ up: true, down: true });
  // 59 rows through 8: the last line reaches the bottom row after 51; the editor keeps
  // the wheel for a tail of 2 more (a quarter of its height), and only then lets it go.
  await turn(EDITOR, "down", 16);
  expect(screenShows("line 29")).toBe(true);
  expect(room(EDITOR)).toEqual({ up: true, down: true });
  expect(await turn(EDITOR, "down")).toBe(true);
  expect(room(EDITOR)).toEqual({ up: true, down: false });
  expect(await turn(EDITOR, "down")).toBe(false);
});

test("an editor whose text fits has no room either way: a short note never scrolls", async () => {
  await act(async () => {
    ui = await testRender(
      <box width={WIDTH} height={HEIGHT}>
        <MarkdownEditor
          value={lines(3).join("\n\n")}
          syntaxStyle={style}
          terminalBackground={RGBA.fromHex("#0d1117")}
          flexGrow={1}
        />
      </box>,
      { width: WIDTH, height: HEIGHT },
    );
  });
  await ui?.renderOnce();
  expect(room({ x: 2, y: 2 })).toEqual({ up: false, down: false });
  expect(await turn({ x: 2, y: 2 }, "down")).toBe(false);
});

test("a renderable that handles the wheel itself keeps it, whatever it does with it", async () => {
  await screen();
  expect(room(CANVAS)).toEqual({ up: true, down: true });
});

test("outside the screen, no room", async () => {
  await screen();
  expect(room({ x: WIDTH + 5, y: HEIGHT + 5 })).toEqual({ up: false, down: false });
});
