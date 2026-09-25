/**
 * The smallest proof (docs/WEB.md, R1): OpenTUI on opentui.wasm draws a bordered box and
 * its text into a custom stdout, through NativeSpanFeed, without a render thread. The
 * bytes go to this process's stdout, so a PTY driver can read the screen they draw.
 */
import "./setup-bun";
import { PassThrough } from "node:stream";
import { createCliRenderer, BoxRenderable, TextRenderable } from "@opentui/core";
import { isInputStream, terminalOutput } from "./streams";

const SIZE = { columns: 50, rows: 8 };
const BOX = { width: 40, height: 5 };
const SHOWN_MS = 500;
const TEARDOWN_MS = 100;

const stdout = terminalOutput(SIZE, (chunk, done) => process.stdout.write(chunk, done));
const stdin = new PassThrough();
if (!isInputStream(stdin)) throw new Error("unreachable: a PassThrough is readable");
const renderer = await createCliRenderer({
  stdin,
  stdout,
  width: SIZE.columns,
  height: SIZE.rows,
  useThread: false,
  exitOnCtrlC: false,
  exitSignals: [],
});
const box = new BoxRenderable(renderer, {
  id: "box",
  ...BOX,
  border: true,
  borderStyle: "rounded",
  title: "airtty",
});
box.add(new TextRenderable(renderer, { id: "text", content: "Hello from opentui.wasm" }));
renderer.root.add(box);
renderer.requestRender();
// Under a PTY driver, the screen stays until a key; alone, half a second.
if (process.env.PROBE_HOLD === "1")
  await new Promise((resolve) => process.stdin.once("data", resolve));
else await Bun.sleep(SHOWN_MS);
renderer.destroy();
await Bun.sleep(TEARDOWN_MS);
process.exit(0);
