/**
 * Flow production smoke: built artefacts, separate Server and Client processes, real PTY.
 *
 * Journey: the pipeline fits the view → tab and ] select along the graph → a adds a step,
 * n renames it, x removes it → c, tab, Enter link two steps → a click selects, a drag
 * moves a step → r runs the pipeline live (animated edges, a flaky step fails, the rest is
 * skipped) → - and 0 zoom out and back. A second Client then sees the link and the move:
 * they reached the Server. Writes docs/flow-pty-frame.txt.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { drive, Keys, type Driver } from "./driver";
import { BUN, ROOT, build, example, report, startServer, temporaryDirectory } from "./harness";

const APP = example("flow");
const ESC = "\x1b";
const COLS = 160;
const ROWS = 40;

build(APP);
using directory = temporaryDirectory("flow-pty-");
await using server = await startServer(APP, { FLOW_RUN_SCALE: "0.3" });
const client = () =>
  drive({
    command: [BUN, join(APP, ".luciole/client/index.js"), "--url", server.url],
    cols: COLS,
    rows: ROWS,
    env: { NODE_ENV: "production", XDG_STATE_HOME: join(directory.path, "state") },
    settle: 150,
  });
await using t = await client();
const results: Record<string, unknown> = { productionPTY: true };

/** Where `text` first shows, 0-based. */
async function find(d: Driver, text: string) {
  const lines = await d.lines();
  const row = lines.findIndex((line) => line.includes(text));
  if (row < 0) throw new Error(`${JSON.stringify(text)} is not shown:\n${lines.join("\n")}`);
  return { row, column: (lines[row] ?? "").indexOf(text) };
}
/** A left-button drag from one cell to another (SGR, 1-based), one cell at a time. */
async function drag(d: Driver, from: { row: number; column: number }, dx: number, dy: number) {
  const at = (x: number, y: number) => `${x + 1};${y + 1}`;
  d.write(`${ESC}[<0;${at(from.column, from.row)}M`);
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  for (let i = 1; i <= steps; i++) {
    const x = from.column + Math.round((dx * i) / steps);
    const y = from.row + Math.round((dy * i) / steps);
    d.write(`${ESC}[<32;${at(x, y)}M`);
    // The pace of a hand: the gesture itself, not a wait for its effect.
    await Bun.sleep(20);
  }
  await d.type(`${ESC}[<0;${at(from.column + dx, from.row + dy)}m`);
}

// The whole pipeline fits at full detail.
await t.waitFor("╭─ checkout");
await t.waitFor("╔═ production");
await t.waitFor("never run");
results.fitsAtFullDetail = true;

// Keyboard: tab selects the first step, ] follows its link.
await t.type(Keys.tab);
await t.waitFor("$ git clone --depth 1");
await t.type("]");
await t.waitFor("after: checkout");

// a adds a step after install, on the Server; n renames it; x removes it.
await t.type("a");
await t.waitFor("Added step 1 after install");
await t.waitFor("╭─ step 1");
await t.type("n");
await t.waitFor("enter saves");
// Keys typed in the field are text, not canvas commands.
await t.type("\x7f".repeat("step 1".length));
await t.type("docs");
await t.type(Keys.enter);
await t.waitFor("╭─ docs");
await t.type("x");
await t.waitFor("╭─ docs", { absent: true });
await t.waitFor("9 steps · 11 links");
results.addRenameRemove = true;

// c links the selected step to a proposed target; tab proposes the next one.
await t.type(Keys.tab);
await t.waitFor("$ git clone --depth 1");
await t.type("c");
await t.waitFor("connect");
await t.type(Keys.tab);
await t.type(Keys.enter);
await t.waitFor("before: install, lint");
results.keyboardLink = "checkout → lint";

// The mouse: a click selects, a drag moves.
await t.click("build ──");
await t.waitFor("before: e2e, staging");
const build0 = await find(t, "build ──");
await drag(t, build0, 0, 3);
await t.until(
  async () => (await t.lines()).findIndex((line) => line.includes("build ──")) === build0.row + 3,
  "the drag never moved build three rows down",
);
results.mouseDrag = "build +3 rows";

// r runs the pipeline on the Server; the run streams back.
await t.escape();
await t.type("r");
await t.waitFor("run #1 · running");
await t.waitFor((text) => /[━┃]/.test(text) || /[╌╎]/.test(text));
results.animatedEdges = true;
await t.waitFor("run #1 · failed");
await t.waitFor("✗ failed");
await t.waitFor("– skipped");
await Bun.write(join(ROOT, "docs/flow-pty-frame.txt"), await t.snapshot());
results.runStreamed = "run #1: e2e fails (flaky), production skipped";

// Semantic zoom: labels only, then back to fit.
await t.type("-");
await t.waitFor("compact");
await t.waitFor("╭─ checkout", { absent: true });
await t.waitFor(" ✓ lint ");
await t.type("0");
await t.waitFor("╭─ checkout");
results.semanticZoom = "full → compact → full";
await t.quit();

// Another Client reads the pipeline from the Server: the link and the move are there.
{
  await using other = await client();
  await other.waitFor("╭─ checkout");
  await other.waitFor("9 steps · 12 links");
  await other.type(Keys.tab);
  await other.waitFor("before: install, lint");
  const a = await find(other, "install ──");
  const b = await find(other, "build ──");
  assert.equal(b.row - a.row, 3, "build is three rows below install for another Client too");
  await other.quit();
}
results.changesReachedServer = true;

report({
  ...results,
  journey: "fit → tab/] → add/rename/remove → link → click/drag → run → zoom → second Client",
  terminalRestored: true,
});
