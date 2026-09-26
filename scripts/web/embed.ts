/**
 * The web runtime framed by a page of its origin (docs/WEB.md, "Page embarquée"), as the
 * landing page frames its live demos: the page hears the start stage by stage, fixes the
 * grid, and types into the terminal; a frame of another origin types nothing. Builds
 * examples/notes with `--web-local`.
 *   bun run test:web:embed
 */
import { join } from "node:path";
import { build, example } from "../pty/harness";
import { Browser } from "./cdp";
import { serveSite } from "./site";

const COLUMNS = 100;
const ROWS = 30;
const FRAME_SCREEN = `[...document.querySelector("iframe").contentDocument.querySelectorAll(".xterm-rows > div")]`;
const OTHER_ORIGIN_WAIT_MS = 1500;
const DRAW_TIMEOUT_MS = 6000;
const POLL_MS = 150;
const frameShows = (text: string) =>
  `${FRAME_SCREEN}.map((row) => row.textContent).join("\\n").includes(${JSON.stringify(text)})`;

build(example("notes"), ["--web-local"]);
const site = join(example("notes"), ".airtty/web");
const notes = serveSite(site);
const look = `index.html?columns=${COLUMNS}&rows=${ROWS}&background=0a0f16`;
// The embedding page: it records every stage it hears, from any origin, and frames `?src=`.
const host = `<!doctype html><body style="margin:0"><iframe style="width:1100px;height:640px;border:0"></iframe>
<script>
  window.stages = [];
  addEventListener("message", (event) => {
    if (event.data?.source === "airtty") stages.push(event.data.stage);
  });
  document.querySelector("iframe").src = new URLSearchParams(location.search).get("src");
</script>`;
const hostSite = Bun.serve({
  port: 0,
  fetch: (request) =>
    new URL(request.url).pathname === "/host.html"
      ? new Response(host, { headers: { "content-type": "text/html; charset=utf-8" } })
      : fetch(new URL(new URL(request.url).pathname, notes.url)),
});
const report: Record<string, unknown> = {};
try {
  // The page's own origin: the host site also serves Notes.
  await using browser = await Browser.start();
  await browser.open(new URL(`/host.html?src=/${encodeURIComponent(look)}`, hostSite.url).href);
  await browser.waitFor(`window.stages.includes("drawn")`, "the drawn stage");
  report.stages = await browser.evaluate("window.stages.join(',')");
  await browser.waitFor(frameShows("First note"), "the Notes screen");
  report.grid = await browser.evaluate(
    `(() => { const rows = ${FRAME_SCREEN}; return rows.length + "x" + Math.max(...rows.map((r) => r.textContent.length)); })()`,
  );
  report.pageColour = await browser.evaluate(
    `getComputedStyle(document.querySelector("iframe").contentDocument.body).backgroundColor`,
  );
  // Framed, the terminal leaves the focus where it was: the embedding page's.
  report.focusStayed = await browser.evaluate(`document.activeElement === document.body`);

  await browser.evaluate(
    `document.querySelector("iframe").contentWindow.postMessage({ source: "airtty", type: "input", data: "\\r" }, "*")`,
  );
  report.typedByTheHost = !!(await browser.waitFor(frameShows("baseline:"), "the note editor"));

  // Another origin frames Notes: it hears no stage, and what it types is ignored. Its
  // script cannot read the frame; the DevTools protocol reads through it.
  const framed = new URL(look, notes.url).href;
  await browser.open(new URL(`/host.html?src=${encodeURIComponent(framed)}`, hostSite.url).href);
  const everything = async () =>
    JSON.stringify(await browser.send("DOM.getDocument", { depth: -1, pierce: true }));
  const deadline = performance.now() + DRAW_TIMEOUT_MS;
  while (!(await everything()).includes("First note") && performance.now() < deadline)
    await Bun.sleep(POLL_MS);
  await browser.evaluate(
    `document.querySelector("iframe").contentWindow.postMessage({ source: "airtty", type: "input", data: "\\r" }, "*")`,
  );
  await Bun.sleep(OTHER_ORIGIN_WAIT_MS);
  const screen = await everything();
  report.otherOriginDrawn = screen.includes("First note");
  report.otherOriginTyped = screen.includes("baseline:");
  report.otherOriginHeard = await browser.evaluate("window.stages.length");
} finally {
  await notes.stop(true);
  await hostSite.stop(true);
}
console.log(JSON.stringify(report, null, 2));
const expected = {
  stages: "runtime,bundle,server,terminal,drawn",
  grid: `${ROWS}x${COLUMNS}`,
  pageColour: "rgb(10, 15, 22)",
  focusStayed: true,
  typedByTheHost: true,
  otherOriginDrawn: true,
  otherOriginTyped: false,
  otherOriginHeard: 0,
};
for (const [key, value] of Object.entries(expected))
  if (report[key] !== value)
    throw new Error(`${key}: expected ${String(value)}, got ${String(report[key])}`);
