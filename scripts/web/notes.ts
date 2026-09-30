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
import { cellOf, rowWith, shows } from "./site";

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
const first = await browser.waitFor(shows("Welcome to Notes"), "the Notes screen");
report.firstScreenMs = Math.round(performance.now() - started);
report.redirectedToRuntime =
  String(await browser.evaluate("location.pathname")) === "/_luciole/web/";
console.log(first);

// Everything by pointing: open a note from the list, edit it, finish.
await browser.clickAt(cellOf("Welcome to Notes"));
await browser.waitFor(shows("✎ Edit"), "the note");
const screenshot = join(example("notes"), ".luciole/web-journey.png");
await browser.screenshot(screenshot);
// A Server Function from the page: a POST, with the declared Origin, admitted.
const BASE36 = 36;
const marker = `web${Date.now().toString(BASE36)}`;
const BODY = "Written in the browser";
await browser.clickAt(cellOf("+ New note"));
await browser.waitFor(shows("✓ Done"), "the new note, its title ready");
await browser.insertText(marker);
await browser.press("Enter");
await browser.insertText(BODY);
await browser.waitFor(shows(BODY), "the typed text");
await browser.clickAt(cellOf("✓ Done"));
report.savedFromThePage = !!(await browser.waitFor(
  `${rowWith("✓ Saved")} && ${rowWith(marker, "⋯")} && ${shows(BODY)}`,
  "the saved note, listed under its title",
));
await browser.clickAt(cellOf("Shopping list"));
await browser.waitFor(shows("Coffee beans"), "the other note");
await browser.clickAt(cellOf(marker));
await browser.waitFor(shows(BODY), "the reopened note");

// The tab's session: a reload reopens the same entry, from localStorage.
await browser.open(origin);
report.reloadRestoresTheNote = !!(await browser.waitFor(shows(BODY), "the restored note"));
report.otherOriginRefused =
  (await fetch(`${server.url}/manifest`, { headers: { origin: "http://evil.example" } })).status ===
  FORBIDDEN;
console.log(JSON.stringify({ ...report, screenshot }, null, 2));
