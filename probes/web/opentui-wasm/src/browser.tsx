/**
 * The form of form-app.tsx in a page (docs/WEB.md, § 4): OpenTUI on opentui.wasm writes
 * its frames to xterm.js, and xterm.js hands the keys back as the renderer's stdin.
 * `window.airtty` exposes what a test reads: the terminal and whether it quit.
 */
import "./setup-browser";
import { PassThrough } from "node:stream";
import { Terminal } from "@xterm/xterm";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { Form } from "./form-app";
import { isInputStream, terminalOutput } from "./streams";

const SIZE = { columns: 60, rows: 14 };

declare global {
  var airtty: { terminal: Terminal; quit: boolean } | undefined;
}

const screen = document.getElementById("screen");
if (!screen) throw new Error("index.html has no #screen");
const terminal = new Terminal({ cols: SIZE.columns, rows: SIZE.rows });
terminal.open(screen);
terminal.focus();
globalThis.airtty = { terminal, quit: false };

const stdin = new PassThrough();
if (!isInputStream(stdin)) throw new Error("unreachable: a PassThrough is readable");
terminal.onData((data) => stdin.write(data));
const renderer = await createCliRenderer({
  stdin,
  stdout: terminalOutput(SIZE, (chunk, done) => terminal.write(chunk, done)),
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
      if (globalThis.airtty) globalThis.airtty.quit = true;
    }}
  />,
);
