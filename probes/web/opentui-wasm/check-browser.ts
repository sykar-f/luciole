/**
 * The form of form-app.tsx in headless Chrome, behind xterm.js: typed into, read from the
 * terminal's buffer, captured as `.airtty/browser/screen.png`.
 *   OPENTUI_SRC=… OPENTUI_WASM_PATH=…/opentui.wasm bun probes/web/opentui-wasm/check-browser.ts
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Browser } from "../../../scripts/web/cdp";

const wasm = process.env.OPENTUI_WASM_PATH;
if (!wasm) throw new Error("OPENTUI_WASM_PATH: the opentui.wasm to serve");
const here = import.meta.dir;
const out = join(here, ".airtty/browser");
mkdirSync(out, { recursive: true });
const build = Bun.spawnSync(
  [process.execPath, join(here, "build.ts"), join(here, "src/browser.tsx"), out, "browser"],
  { stdio: ["ignore", "ignore", "inherit"] },
);
if (build.exitCode !== 0) process.exit(1);
copyFileSync(join(here, "static/index.html"), join(out, "index.html"));
copyFileSync(wasm, join(out, "opentui.wasm"));
copyFileSync(
  resolve(here, "../../../node_modules/@xterm/xterm/css/xterm.css"),
  join(out, "xterm.css"),
);

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const file = Bun.file(join(out, path === "/" ? "index.html" : path));
    return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 });
  },
});
const SCREEN = `(() => {
  const t = globalThis.airtty?.terminal;
  if (!t) return "";
  const b = t.buffer.active;
  return Array.from({ length: t.rows }, (_, i) => b.getLine(b.viewportY + i)?.translateToString(true) ?? "").join("\\n");
})()`;
const shows = (text: string) => `${SCREEN}.includes(${JSON.stringify(text)}) && ${SCREEN}`;

try {
  await using browser = await Browser.start();
  const started = performance.now();
  await browser.open(server.url.href);
  await browser.waitFor(shows("Type a note"), "the form");
  console.log(`first frame after ${Math.round(performance.now() - started)} ms`);
  await browser.insertText("héllo wasm");
  await browser.waitFor(shows("héllo wasm"), "the typed text");
  await browser.press("Enter");
  await browser.waitFor(shows("1. héllo wasm"), "the first note");
  await browser.insertText("日本語 second");
  await browser.press("Enter");
  await browser.waitFor(shows("2. 日本語 second"), "the second note");
  console.log(await browser.evaluate(SCREEN));
  await browser.screenshot(join(out, "screen.png"));
  await browser.press("Escape");
  await browser.waitFor("globalThis.airtty?.quit === true", "the quit");
  console.log(`quit; screenshot in ${join(out, "screen.png")}`);
} finally {
  await server.stop(true);
}
