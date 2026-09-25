/**
 * The window's terminal: xterm.js renders the program's output and encodes the user's
 * keys, mouse and pastes, which the host writes to the PTY unfiltered (src/host).
 */
import { Electroview } from "electrobun/view";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { TerminalRPC } from "../protocol";

const container = document.getElementById("terminal");
if (!container) throw new Error("The view has no #terminal element");

const terminal = new Terminal({
  fontFamily: '"SF Mono", Menlo, "DejaVu Sans Mono", monospace',
  fontSize: 13,
  // OpenTUI draws its own cursor and scrolls its own views.
  cursorBlink: false,
  scrollback: 0,
  // Option is Alt, as the keymaps of terminal applications expect.
  macOptionIsMeta: true,
  theme: { background: "#0d1117" },
});
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open(container);
// The GPU renderer when the webview has WebGL2; the DOM renderer otherwise.
try {
  const webgl = new WebglAddon();
  webgl.onContextLoss(() => webgl.dispose());
  terminal.loadAddon(webgl);
} catch {}
fit.fit();

const rpc = Electroview.defineRPC<TerminalRPC>({
  handlers: { messages: { output: ({ data }) => terminal.write(data) } },
});
new Electroview({ rpc });

terminal.onData((data) => rpc.send.input({ data }));
// Mouse reports in the legacy encoding are bytes, not UTF-8: one char per byte.
terminal.onBinary((data) => rpc.send.input({ data, binary: true }));
terminal.onResize((size) => rpc.send.resize(size));
new ResizeObserver(() => fit.fit()).observe(container);
rpc.send.open({ cols: terminal.cols, rows: terminal.rows });
terminal.focus();
