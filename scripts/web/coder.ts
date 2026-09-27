/**
 * coder as a static site (docs/WEB.md, `--web-local`): the website's live demo. The
 * scripted harness answers in the Server's Worker, with the seed website/scripts/demo.ts
 * writes, and plays the demo's session: read, reply, diff to approve, tests, prompt back.
 * The Agent SDK must stay out of the Worker (packages/harness/package.json, `exports`).
 *   bun run test:web:coder
 */
import { join } from "node:path";
import { DEMO_END, DEMO_PROMPT } from "../../packages/harness/src/adapters/fake";
import { SCRIPTED } from "../../packages/harness/src/ui/StatusLine";
import { build, example } from "../pty/harness";
import { Browser } from "./cdp";
import { rowWith, SCREEN, serveSite, shows } from "./site";

/** How many colours the first row showing `text` is drawn in: one means no highlighting. */
const coloursOfRow = (text: string) =>
  `(() => { const row = [...document.querySelectorAll(".xterm-rows > div")].find((r) => r.textContent.includes(${JSON.stringify(text)})); return row ? new Set([...row.querySelectorAll("span")].map((s) => getComputedStyle(s).color)).size : 0; })()`;

/** Two frames: what a key changed (the focused field) is drawn before the next key. */
const FRAMES =
  "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))";
const KIB = 1024;
const PROJECT = "/home/ada/src/timers";
build(example("coder"), ["--web-local"]);
const site = join(example("coder"), ".airtty/web");
const worker = await Bun.file(join(site, "server-worker.js")).text();
await Bun.write(
  join(site, "server-seed.json"),
  JSON.stringify({ env: { CODER_HARNESS: "fake", CODER_CWD: PROJECT } }),
);
const files = serveSite(site);
const report: Record<string, unknown> = {
  workerKb: Math.round(worker.length / KIB),
  noAgentSdk: !worker.includes("claude-agent-sdk") && !worker.includes("ClaudeHarness"),
};
try {
  await using browser = await Browser.start();
  try {
    await browser.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    // The website's grid for its gallery: 140 × 40.
    await browser.send("Emulation.setDeviceMetricsOverride", {
      width: 1300,
      height: 820,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const started = performance.now();
    await browser.open(files.url.href);
    await browser.waitFor(shows(SCRIPTED), "the scripted demo's status line");
    report.firstScreenMs = Math.round(performance.now() - started);
    report.project = !!(await browser.waitFor(shows(PROJECT), "the seeded project path"));

    // In the prompt's box: a click in the transcript would leave the prompt for it.
    await browser.clickAt(
      `(() => { const row = [...document.querySelectorAll(".xterm-rows > div")].find((r) => r.textContent.includes("Message…")).getBoundingClientRect(); return { x: row.x + row.width / 2, y: row.y + row.height / 2 }; })()`,
    );
    await browser.evaluate(FRAMES);
    await browser.insertText(DEMO_PROMPT);
    await browser.waitFor(shows("then run its tests"), "the typed prompt");
    await browser.press("Enter");
    const played = performance.now();
    report.toolCall = !!(await browser.waitFor(shows("⚙ read src/duration.ts"), "the read"));
    await browser.waitFor(shows("allow once"), "the approval of the edit");
    report.diffHighlighted = !!(await browser.waitFor(
      `${coloursOfRow("throw new RangeError")} > 2`,
      "a highlighted diff",
    ));
    await browser.insertText("y");
    report.tests = !!(await browser.waitFor(shows("✓ exit 0 · 1.8 s"), "the test run"));
    report.promptBack = !!(await browser.waitFor(rowWith(DEMO_END), "the end of the demo"));
    report.scenarioMs = Math.round(performance.now() - played);
    await browser.screenshot(join(example("coder"), ".airtty/web-local.png"));
  } catch (error: unknown) {
    // What the screen showed instead: the scenario's text changes more than its steps.
    console.error(await browser.evaluate(SCREEN).catch(() => ""));
    throw error;
  }
} finally {
  await files.stop(true);
}
console.log(JSON.stringify(report, null, 2));
