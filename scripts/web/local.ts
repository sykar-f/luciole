/**
 * Notes as a static site (docs/WEB.md, step 3): no luciole Server anywhere, only files;
 * the page runs the Client and a SharedWorker runs the Server, SQLite in WebAssembly, its
 * data in the origin's private file system. Builds examples/notes with `--web-local`.
 *   bun run test:web:local
 */
import { join } from "node:path";
import { build, example } from "../pty/harness";
import { Browser } from "./cdp";
import { cellOf, rowWith, serveSite, shows } from "./site";

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
  console.log(await browser.waitFor(shows("Welcome to Notes"), "the Notes screen"));
  report.firstScreenMs = Math.round(performance.now() - started);
  report.sharedWorker = await browser.evaluate("typeof SharedWorker === 'function'");

  // The terminal loses the focus, then a click in it brings it back: it must still draw
  // what the application sends.
  await browser.evaluate(`document.querySelector(".xterm-helper-textarea").blur()`);
  await browser.click(".xterm-screen");

  // A note written in the browser: New note, a title, Return, its text, saved by itself.
  const BASE36 = 36;
  const marker = `local${Date.now().toString(BASE36)}`;
  const BODY = "Kept in the origin's files";
  await browser.clickAt(cellOf("+ New note"));
  await browser.waitFor(shows("Untitled"), "the new note, its title ready");
  await browser.insertText(marker);
  await browser.press("Enter");
  await browser.insertText(BODY);
  await browser.waitFor(shows(BODY), "the typed text");
  report.savedInTheBrowser = !!(await browser.waitFor(
    `!${rowWith("●", marker)} && ${rowWith(marker, "⋯")}`,
    "the saved note, listed under its title",
  ));

  // A new page load: a new Worker, the database read back from OPFS.
  await browser.open(`${files.url.href}?reload`);
  await browser.waitFor(shows(marker), "the list again");
  await browser.clickAt(cellOf(marker));
  report.persistedAcrossLoads = !!(await browser.waitFor(shows(BODY), "the stored note"));

  // A click on another note opens it.
  await browser.clickAt(cellOf("Shopping list"));
  report.openedByClick = !!(await browser.waitFor(shows("Coffee beans"), "the clicked note"));
  await browser.screenshot(join(example("notes"), ".luciole/web-local.png"));
} finally {
  await files.stop(true);
}
console.log(JSON.stringify(report, null, 2));
