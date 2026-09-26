/**
 * Forge as a static site (docs/WEB.md, `--web-local`): the landing page's live demo. Its
 * Server hashes session tokens and encodes them in base64url, its Client imports
 * `child_process` for a terminal-only key, and its diffs need tree-sitter and the gutter
 * of <diff>: each of those broke Forge in a page once. Builds examples/forge.
 *   bun run test:web:forge
 */
import { join } from "node:path";
import { build, example } from "../pty/harness";
import { Browser } from "./cdp";
import { rowWith, serveSite, shows } from "./site";

/** How many colours the first row showing `text` is drawn in: one means no highlighting. */
const coloursOfRow = (text: string) =>
  `(() => { const row = [...document.querySelectorAll(".xterm-rows > div")].find((r) => r.textContent.includes(${JSON.stringify(text)})); return row ? new Set([...row.querySelectorAll("span")].map((s) => getComputedStyle(s).color)).size : 0; })()`;

/** Two frames: what a key changed (the focused field) is drawn before the next key. */
const FRAMES =
  "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))";

build(example("forge"), ["--web-local"]);
const files = serveSite(join(example("forge"), ".airtty/web"));
const report: Record<string, unknown> = {};
try {
  await using browser = await Browser.start();
  await browser.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  // Forge lays out for a wide terminal: sidebar, file list and diff side by side.
  await browser.send("Emulation.setDeviceMetricsOverride", {
    width: 1300,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const started = performance.now();
  await browser.open(files.url.href);
  await browser.waitFor(shows("Demo accounts"), "the sign-in screen");
  report.firstScreenMs = Math.round(performance.now() - started);

  // Sign-in: a SHA-256 of the token and its base64url, on the Server in a Worker.
  await browser.click(".xterm-screen");
  await browser.insertText("alice");
  await browser.waitFor(rowWith("User", "alice"), "the user name");
  await browser.press("Enter");
  await browser.evaluate(FRAMES);
  await browser.insertText("forge");
  await browser.evaluate(FRAMES);
  await browser.press("Enter");
  report.signedIn = !!(await browser.waitFor(shows("REVIEW REQUESTED"), "the inbox"));

  // payments#1, second in the inbox; its Files tab: a Markdown diff first.
  await browser.insertText("j");
  await browser.evaluate(FRAMES);
  await browser.press("Enter");
  await browser.waitFor(shows("Add idempotency keys to refunds"), "the pull request");
  await browser.press("Tab");
  await browser.waitFor(shows("README.md · markdown"), "the Files tab");
  report.gutter = !!(await browser.waitFor(
    rowWith("7 + ", "`POST /refunds`"),
    "numbered and signed diff lines",
  ));
  report.highlighted = !!(await browser.waitFor(
    `${coloursOfRow("7 + `POST /refunds`")} > 2`,
    "highlighted Markdown",
  ));
  await browser.screenshot(join(example("forge"), ".airtty/web-local.png"));
} finally {
  await files.stop(true);
}
console.log(JSON.stringify(report, null, 2));
