/**
 * Notes in a browser, against its real Server (docs/WEB.md, step 2): the Server serves the
 * web runtime on its declared origin, headless Chrome opens it, and the journey reads the
 * screen xterm.js draws. Builds examples/notes with `--web`: the web runtime must be
 * prepared (`luciole web-runtime`, Zig 0.16.0 in ZIG) or preparable.
 *   bun run test:web
 */
import { join } from "node:path";
import { build, example, startServer } from "../pty/harness";
import { Browser } from "./cdp";
import { shows } from "./site";

const FORBIDDEN = 403;
/** A port nobody listens on now: the Server's origin must name it before it starts. */
function freePort() {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = probe;
  void probe.stop(true);
  if (port === undefined) throw new Error("no free port");
  return port;
}

build(example("notes"), ["--web"]);
const port = freePort();
const origin = `http://127.0.0.1:${port}`;
const report: Record<string, unknown> = {};
await using server = await startServer(example("notes"), {
  PORT: String(port),
  LUCIOLE_WEB_ORIGIN: origin,
});
await using browser = await Browser.start();
const started = performance.now();
await browser.open(origin);
const first = await browser.waitFor(shows("NOTES"), "the Notes screen");
report.firstScreenMs = Math.round(performance.now() - started);
report.redirectedToRuntime =
  String(await browser.evaluate("location.pathname")) === "/_luciole/web/";
console.log(first);
const screenshot = join(example("notes"), ".luciole/web-journey.png");
await browser.screenshot(screenshot);

// A Server Function from the page: a POST, with the declared Origin, admitted.
const BASE36 = 36;
const marker = `web${Date.now().toString(BASE36)}`;
await browser.press("Enter");
await browser.waitFor(shows("baseline:"), "the note editor");
await browser.insertText(marker);
await browser.waitFor(shows(marker), "the typed text");
await browser.press("Enter");
report.savedFromThePage = !!(await browser.waitFor(
  `[...document.querySelectorAll(".xterm-rows > div")].some((row) => row.textContent.includes("baseline:") && row.textContent.includes(${JSON.stringify(marker)}))`,
  "the saved baseline",
));
await browser.press("Escape");
await browser.waitFor(shows("YOUR NOTES"), "the list");
await browser.press("Enter");
await browser.waitFor(shows(marker), "the reopened note");

// The tab's session: a reload reopens the same entry, from localStorage.
await browser.open(origin);
report.reloadRestoresTheNote = !!(await browser.waitFor(shows("baseline:"), "the restored note"));
report.otherOriginRefused =
  (await fetch(`${server.url}/manifest`, { headers: { origin: "http://evil.example" } })).status ===
  FORBIDDEN;
console.log(JSON.stringify({ ...report, screenshot }, null, 2));
