/**
 * Notes as a static site (docs/WEB.md, step 3): no luciole Server anywhere, only files;
 * the page runs the Client and a SharedWorker runs the Server, SQLite in WebAssembly, its
 * data in the origin's private file system. Builds examples/notes with `--web-local`.
 *   bun run test:web:local
 */
import { join } from "node:path";
import { build, example } from "../pty/harness";
import { Browser } from "./cdp";
import { rowWith, serveSite, shows } from "./site";

build(example("notes"), ["--web-local"]);
const site = join(example("notes"), ".luciole/web");
const files = serveSite(site);
const report: Record<string, unknown> = {};
try {
  await using browser = await Browser.start();
  // Headless, the window never has the focus: the terminal would see no focus change.
  await browser.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const started = performance.now();
  await browser.open(files.url.href);
  console.log(await browser.waitFor(shows("First note"), "the Notes screen"));
  report.firstScreenMs = Math.round(performance.now() - started);
  report.sharedWorker = await browser.evaluate("typeof SharedWorker === 'function'");

  // The terminal loses the focus, then a click in it brings it back: it must still draw
  // what the application sends.
  await browser.evaluate(`document.querySelector(".xterm-helper-textarea").blur()`);
  await browser.click(".xterm-screen");

  const BASE36 = 36;
  const marker = `local${Date.now().toString(BASE36)}`;
  await browser.press("Enter");
  await browser.waitFor(shows("baseline:"), "the note editor");
  await browser.insertText(marker);
  await browser.waitFor(shows(marker), "the typed text");
  await browser.press("Enter");
  report.savedInTheBrowser = !!(await browser.waitFor(
    rowWith("baseline:", marker),
    "the saved baseline",
  ));
  await browser.press("Escape");
  await browser.waitFor(shows("YOUR NOTES"), "the list");

  // A new page load: a new Worker, the database read back from OPFS.
  await browser.open(`${files.url.href}?reload`);
  await browser.waitFor(shows("First note"), "the list again");
  await browser.press("Enter");
  report.persistedAcrossLoads = !!(await browser.waitFor(shows(marker), "the stored note"));

  // A click on a note opens it, as Enter does.
  await browser.press("Escape");
  await browser.waitFor(shows("YOUR NOTES"), "the list once more");
  await browser.clickAt(
    `(() => { const row = [...document.querySelectorAll(".xterm-rows > div")].find((r) => r.textContent.includes("Second note")).getBoundingClientRect(); return { x: row.x + row.width / 4, y: row.y + row.height / 2 }; })()`,
  );
  report.openedByClick = !!(await browser.waitFor(shows("Second note ·"), "the clicked note"));
  await browser.screenshot(join(example("notes"), ".luciole/web-local.png"));
} finally {
  await files.stop(true);
}
console.log(JSON.stringify(report, null, 2));
