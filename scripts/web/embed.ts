/**
 * The web runtime framed by a page of its origin (docs/WEB.md, "Page embarquée"), as the
 * landing page frames its live demos: the page hears the start stage by stage, fixes the
 * grid and the route it opens on, types into the terminal, puts the round trip before the
 * keys, and asks whether the wheel still scrolls something under a point; a frame of another
 * origin types nothing. Builds examples/notes with `--web-local`.
 *   bun run test:web:embed
 */
import { join } from "node:path";
import * as z from "zod/mini";
import { build, example } from "../pty/harness";
import { Browser } from "./cdp";
import { SCREEN, serveSite } from "./site";

const COLUMNS = 100;
const ROWS = 30;
const FRAME = `document.querySelector("iframe").contentWindow`;
const OTHER_ORIGIN_WAIT_MS = 1500;
const LATENCY_MS = 300;
const KEYS_LATENCY_MS = 1200;
const KEY = "Q";
const DRAW_TIMEOUT_MS = 6000;
/** A turn of the wheel, in rows, and a trackpad's small turns adding up to two rows. */
const WHEEL_ROWS = 3;
const SWIPE = { turns: 5, rows: 0.42 };
const WheelPoint = z.object({ x: z.number(), y: z.number(), row: z.number() });
const POLL_MS = 150;
/** Long enough for Return to put the cursor in the note before the next key arrives. */
const EDIT_SETTLE_MS = 300;
/** Cells of Notes, 0-based, with no note open: a row of the list, the toolbar, the note. */
const LIST_CELL = { column: 5, row: 10 };
const TOOLBAR_CELL = { column: 10, row: 1 };
const NOTE_CELL = { column: 60, row: 15 };
const frameShows = (text: string) =>
  `${FRAME}.lucioleScreen().join("\\n").includes(${JSON.stringify(text)})`;

build(example("notes"), ["--web-local"]);
const site = join(example("notes"), ".luciole/web");
const notes = serveSite(site);
const look = `index.html?columns=${COLUMNS}&rows=${ROWS}&background=0a0f16`;
// The embedding page: it records every message it hears, from any origin, and frames `?src=`.
const host = `<!doctype html><body style="margin:0"><iframe style="width:1100px;height:640px;border:0"></iframe>
<script>
  window.heard = [];
  window.stages = [];
  window.events = [];
  addEventListener("message", (event) => {
    if (event.data?.source !== "luciole") return;
    heard.push(event.data);
    if (event.data.type === "stage") stages.push(event.data.stage);
    if (event.data.type === "event") events.push(event.data.event);
  });
  window.send = (message) =>
    document.querySelector("iframe").contentWindow.postMessage({ source: "luciole", ...message }, "*");
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
  await browser.waitFor(frameShows("Welcome to Notes"), "the Notes screen");
  report.grid = await browser.evaluate(
    `(() => { const cells = ${FRAME}.lucioleCells(); return cells.length + "x" + cells[0].length; })()`,
  );
  // The GPU renderer wherever the page has WebGL2 (docs/WEB.md, "Rendu et entrée").
  report.gpu = await browser.evaluate(
    `${FRAME}.lucioleRenderer() === (document.createElement("canvas").getContext("webgl2") ? "webgl" : "dom")`,
  );
  report.pageColour = await browser.evaluate(
    `getComputedStyle(document.querySelector("iframe").contentDocument.body).backgroundColor`,
  );
  // Framed, the terminal leaves the focus where it was: the embedding page's.
  report.focusStayed = await browser.evaluate(`document.activeElement === document.body`);

  // The page slows the network down, then opens the first note (Return, with nothing
  // being typed): the render it hears took at least the round trip.
  await browser.evaluate(`send({ type: "network", latencyMs: ${LATENCY_MS} })`);
  await browser.evaluate(`send({ type: "input", data: "\\r" })`);
  report.typedByTheHost = !!(await browser.waitFor(frameShows("Getting around"), "the note"));
  report.slowedRender = await browser.waitFor(
    `events.some((e) => e.type === "end" && e.kind === "render" && e.ms >= ${LATENCY_MS})`,
    "a render slowed by the page",
  );
  // The next request is refused before it leaves: the save fails as not sent.
  await browser.evaluate(`send({ type: "network", latencyMs: ${LATENCY_MS}, fault: "refuse" })`);
  // Return edits the note, then Ctrl+S saves it.
  await browser.evaluate(`send({ type: "input", data: "\\r" })`);
  // Nothing on screen says the text is being edited: the cursor is in it a moment later.
  await Bun.sleep(EDIT_SETTLE_MS);
  await browser.evaluate(`send({ type: "input", data: "x" })`);
  await browser.waitFor(frameShows("typing.x"), "the edit");
  await browser.evaluate(`send({ type: "input", data: "\\u0013" })`);
  report.refusedSave = await browser.waitFor(
    `events.some((e) => e.type === "error" && e.kind === "action" && e.outcome === "not-sent")`,
    "a save refused before it left",
  );

  // The round trip before the keys, as over SSH: a key typed in the terminal shows only
  // once it has crossed; before, nothing.
  await browser.evaluate(
    `send({ type: "network", latencyMs: ${KEYS_LATENCY_MS}, delays: "keys" })`,
  );
  await browser.evaluate(
    `document.querySelector("iframe").contentDocument.querySelector(".xterm-helper-textarea").focus()`,
  );
  await browser.insertText(KEY);
  await Bun.sleep(KEYS_LATENCY_MS / 2);
  report.keyHeldBack = !(await browser.evaluate(frameShows(`x${KEY}`)));
  report.keyDelivered = !!(await browser.waitFor(frameShows(`x${KEY}`), "the delayed key"));
  // What the terminal sent its app, the page hears, as typed: it may replay it elsewhere.
  report.typedHeard = await browser.evaluate(
    `window.heard.some((m) => m.type === "typed" && m.data === ${JSON.stringify(KEY)})`,
  );

  // Framed again, Notes reopens the note left open; with `restore=off`, its list.
  const reopen = async (src: string) => {
    await browser.open(new URL(`/host.html?src=/${encodeURIComponent(src)}`, hostSite.url).href);
    await browser.waitFor(`window.stages.includes("drawn")`, "the drawn stage");
  };
  await reopen(look);
  report.restored = !!(await browser.waitFor(frameShows("Getting around"), "the restored note"));
  await reopen(`${look}&restore=off`);
  report.notRestored = !!(await browser.waitFor(frameShows("No note selected"), "no note open"));
  // `path`: with nothing restored, the route it opens on, as the landing page's duel does.
  await reopen(`${look}&restore=off&path=/notes/1`);
  report.openedPath = !!(await browser.waitFor(frameShows("Getting around"), "the note asked for"));

  // The wheel's room, as the page asks for it at a point of the frame: the list scrolls
  // down from its top, the toolbar and the empty note scroll nothing; once the list has
  // scrolled, it scrolls back up too.
  const roomAt = (cell: { column: number; row: number }) =>
    browser.evaluate(`(() => {
      const frame = document.querySelector("iframe");
      const box = frame.contentDocument.querySelector(".xterm-screen").getBoundingClientRect();
      const x = box.left + ((${cell.column} + 0.5) * box.width) / ${COLUMNS};
      const y = box.top + ((${cell.row} + 0.5) * box.height) / ${ROWS};
      return JSON.stringify(frame.contentWindow.lucioleScrollRoom(x, y));
    })()`);
  // The note shows before the list beside it has its rows: the list, once drawn, scrolls.
  const listDrawnBy = performance.now() + DRAW_TIMEOUT_MS;
  report.roomOverList = await roomAt(LIST_CELL);
  while (
    report.roomOverList !== JSON.stringify({ up: false, down: true }) &&
    performance.now() < listDrawnBy
  ) {
    await Bun.sleep(POLL_MS);
    report.roomOverList = await roomAt(LIST_CELL);
  }
  report.roomOverToolbar = await roomAt(TOOLBAR_CELL);
  report.roomOverEmptyNote = await roomAt(NOTE_CELL);
  await browser.evaluate(
    `send({ type: "input", data: "\\u001b[<65;${LIST_CELL.column + 1};${LIST_CELL.row + 1}M" })`,
  );
  const scrolledBy = performance.now() + DRAW_TIMEOUT_MS;
  report.roomOverScrolledList = await roomAt(LIST_CELL);
  while (report.roomOverScrolledList === report.roomOverList && performance.now() < scrolledBy) {
    await Bun.sleep(POLL_MS);
    report.roomOverScrolledList = await roomAt(LIST_CELL);
  }

  // A real wheel over the list: one report for each row's height it travels, as a native
  // terminal sends them, what is left kept for the next turn (xterm.js alone sends one per
  // event, and a third of a trackpad's).
  const { x, y, row } = WheelPoint.parse(
    await browser.evaluate(`(() => {
      const frame = document.querySelector("iframe").getBoundingClientRect();
      const box = document.querySelector("iframe").contentDocument.querySelector(".xterm-screen").getBoundingClientRect();
      return {
        x: frame.x + box.left + ((${LIST_CELL.column} + 0.5) * box.width) / ${COLUMNS},
        y: frame.y + box.top + ((${LIST_CELL.row} + 0.5) * box.height) / ${ROWS},
        row: box.height / ${ROWS},
      };
    })()`),
  );
  /** Turns the wheel down by these rows each, and counts the reports the page hears. */
  const wheelReports = async (turns: readonly number[]) => {
    await browser.evaluate("window.heard.length = 0");
    for (const turn of turns)
      await browser.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX: 0,
        deltaY: turn * row,
      });
    await Bun.sleep(POLL_MS);
    return browser.evaluate(
      `window.heard.filter((m) => m.type === "typed").reduce((sum, m) => sum + (m.data.match(/\\x1b\\[<65;/g)?.length ?? 0), 0)`,
    );
  };
  report.wheelNotch = await wheelReports([WHEEL_ROWS]);
  report.wheelSwipe = await wheelReports(Array.from({ length: SWIPE.turns }, () => SWIPE.rows));

  // Another origin frames Notes: it hears no stage, and what it types is ignored. Its
  // script cannot read the frame; the DevTools protocol reads in the frame's own context.
  const framed = new URL(look, notes.url).href;
  await browser.open(new URL(`/host.html?src=${encodeURIComponent(framed)}`, hostSite.url).href);
  const framedScreen = async () =>
    String(await browser.evaluateIn(notes.url.origin, SCREEN).catch(() => ""));
  const deadline = performance.now() + DRAW_TIMEOUT_MS;
  while (!(await framedScreen()).includes("Welcome to Notes") && performance.now() < deadline)
    await Bun.sleep(POLL_MS);
  await browser.evaluate(
    `document.querySelector("iframe").contentWindow.postMessage({ source: "luciole", type: "input", data: "\\r" }, "*")`,
  );
  await Bun.sleep(OTHER_ORIGIN_WAIT_MS);
  const screen = await framedScreen();
  report.otherOriginDrawn = screen.includes("Welcome to Notes");
  report.otherOriginTyped = screen.includes("Getting around");
  report.otherOriginHeard = await browser.evaluate("window.heard.length");
} finally {
  await notes.stop(true);
  await hostSite.stop(true);
}
console.log(JSON.stringify(report, null, 2));
const expected = {
  stages: "runtime,bundle,server,terminal,drawn",
  grid: `${ROWS}x${COLUMNS}`,
  gpu: true,
  pageColour: "rgb(10, 15, 22)",
  focusStayed: true,
  typedByTheHost: true,
  slowedRender: true,
  refusedSave: true,
  keyHeldBack: true,
  keyDelivered: true,
  typedHeard: true,
  restored: true,
  notRestored: true,
  roomOverList: JSON.stringify({ up: false, down: true }),
  roomOverToolbar: JSON.stringify({ up: false, down: false }),
  roomOverEmptyNote: JSON.stringify({ up: false, down: false }),
  roomOverScrolledList: JSON.stringify({ up: true, down: true }),
  wheelNotch: WHEEL_ROWS,
  wheelSwipe: 2,
  openedPath: true,
  otherOriginDrawn: true,
  otherOriginTyped: false,
  otherOriginHeard: 0,
};
for (const [key, value] of Object.entries(expected))
  if (report[key] !== value)
    throw new Error(`${key}: expected ${String(value)}, got ${String(report[key])}`);
