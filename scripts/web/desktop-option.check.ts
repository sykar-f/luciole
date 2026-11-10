/**
 * Option in the desktop view, on xterm.js in headless Chrome (macOS): no keys before the
 * host's settings, then Meta by default, or the composed character when the application
 * declares `"desktop": { "macOptionIsMeta": false }`.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { windowSettings } from "../../packages/desktop/src/settings";
import { Browser } from "./cdp";

const TIMEOUT_MS = 60_000;
const ALT = 1;
const SHIFT = 8;
const KEY_L = 76;
// Option+Shift+L on a French Mac keyboard.
const PIPE = { modifiers: ALT | SHIFT, key: "|", code: "KeyL", windowsVirtualKeyCode: KEY_L };

async function press(browser: Browser) {
  await browser.send("Input.dispatchKeyEvent", { type: "keyDown", ...PIPE, text: "|" });
  await browser.send("Input.dispatchKeyEvent", { type: "keyUp", ...PIPE });
  return browser.evaluate("desktopOption.take()");
}

test(
  "Option+Shift+L in the desktop view, before and after the window's settings",
  async () => {
    if (process.platform !== "darwin") return;
    const bundled = await Bun.build({
      entrypoints: [join(import.meta.dir, "desktop-option-page.ts")],
      target: "browser",
      format: "esm",
    });
    if (!bundled.success) throw new Error(bundled.logs.map(String).join("\n"));
    const script = await bundled.outputs[0]?.text();
    const server = Bun.serve({
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname === "/page.js"
          ? new Response(script, { headers: { "content-type": "text/javascript" } })
          : new Response(`<script type="module" src="/page.js"></script>`, {
              headers: { "content-type": "text/html" },
            }),
    });
    try {
      await using browser = await Browser.start();
      for (const [desktop, expected] of [
        [undefined, "\u001bL"],
        [{ macOptionIsMeta: false }, "|"],
      ] as const) {
        await browser.open(server.url.href);
        await browser.waitFor("!!globalThis.desktopOption", "the terminal");
        expect(await press(browser)).toBe("");
        const settings = windowSettings({
          format: 1,
          name: "notes",
          displayName: "Notes",
          desktop,
        });
        await browser.evaluate(`desktopOption.apply(${JSON.stringify(settings)})`);
        expect(await press(browser)).toBe(expected);
      }
    } finally {
      await server.stop(true);
    }
  },
  TIMEOUT_MS,
);
