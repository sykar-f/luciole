/**
 * The interactive proof (docs/WEB.md, R1): @opentui/react on opentui.wasm, with an
 * <input> fed by keystrokes, a <scrollbox> of what was submitted, and a key binding. The
 * renderer reads this process's stdin and writes its stdout through NativeSpanFeed, as
 * a browser terminal will.
 */
import "./setup-bun";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { Form } from "./form-app";
import { isInputStream, terminalOutput } from "./streams";

const SIZE = { columns: 60, rows: 14 };

const stdin = process.stdin;
if (!isInputStream(stdin)) throw new Error("unreachable: process.stdin is readable");
const renderer = await createCliRenderer({
  stdin,
  stdout: terminalOutput(SIZE, (chunk, done) => process.stdout.write(chunk, done)),
  width: SIZE.columns,
  height: SIZE.rows,
  useThread: false,
  exitOnCtrlC: false,
  exitSignals: [],
});
createRoot(renderer).render(
  <Form
    onQuit={() => {
      renderer.destroy();
      process.exit(0);
    }}
  />,
);
