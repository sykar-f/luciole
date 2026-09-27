/**
 * Photographs /og (src/pages/og.astro) into public/og.png, the picture a shared link shows.
 * Rerun after a change to the palette, the fonts or the Notes capture:
 *   bun run dev            # in another terminal
 *   bun scripts/og.ts http://localhost:4321
 */
import { join } from "node:path";
import { Browser } from "../../scripts/web/cdp";

const base = process.argv[2] ?? "http://localhost:4321";
await using browser = await Browser.start();
await browser.send("Emulation.setDeviceMetricsOverride", {
  width: 1200,
  height: 630,
  deviceScaleFactor: 1,
  mobile: false,
});
await browser.open(`${base}/og/`);
await browser.waitFor(
  "document.readyState === 'complete' && document.fonts.status === 'loaded'",
  "the card",
);
await browser.screenshot(join(import.meta.dirname, "../public/og.png"));
console.log("og: public/og.png");
