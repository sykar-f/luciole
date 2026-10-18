/* eslint-disable no-magic-numbers -- Fixed editor hit-test geometry. */
import "../../packages/core/src/web/setup";
import { PassThrough } from "node:stream";
import { BoxRenderable, createCliRenderer } from "@opentui/core";
import { Terminal } from "@xterm/xterm";
import { syntaxStyle } from "../../packages/core/src/markdown/style";
import { isInputStream, terminalOutput } from "../../packages/core/src/web/streams";
import { MarkdownEditorRenderable } from "../../packages/markdown-editor/src/view/EditorRenderable";

const terminal = new Terminal({ cols: 40, rows: 16, fontSize: 14, allowProposedApi: true });
terminal.open(document.body);
const stdin = new PassThrough();
if (!isInputStream(stdin)) throw new Error("Expected readable stdin");
terminal.onData((data) => stdin.write(data));
const renderer = await createCliRenderer({
  stdin,
  stdout: terminalOutput({ columns: 40, rows: 16 }, (bytes, done) => terminal.write(bytes, done)),
  width: 40,
  height: 16,
  exitOnCtrlC: false,
  exitSignals: [],
});
void renderer.closed.catch(console.error);
const parent = new BoxRenderable(renderer, {
  position: "absolute",
  left: 2,
  top: 0,
  width: 31,
  height: 5,
});
const editor = new MarkdownEditorRenderable(renderer, {
  width: 31,
  height: 5,
  value: Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n\n"),
  syntaxStyle: syntaxStyle({}, renderer),
});
parent.add(editor);
renderer.root.add(parent);
terminal.focus();
Reflect.set(globalThis, "editorHits", {
  at(top: number, scroll: number) {
    parent.top = top;
    editor.scrollableViewport.set(scroll);
    renderer.requestRender();
  },
  selection: () => editor.controller.state.selection.head,
  lines: () =>
    Array.from(
      { length: terminal.rows },
      (_, y) => terminal.buffer.active.getLine(y)?.translateToString(true) ?? "",
    ),
  point(top: number, scroll: number) {
    const box = document.querySelector(".xterm-screen")?.getBoundingClientRect();
    if (!box) throw new Error("Missing xterm screen");
    return {
      x: box.left + ((5.5 + scroll / 2) * box.width) / terminal.cols,
      y: box.top + ((top + 4.5) * box.height) / terminal.rows,
    };
  },
});
