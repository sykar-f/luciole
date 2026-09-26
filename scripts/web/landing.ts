/**
 * The landing page's live demos (website/, LiveTerminal.astro): each one replaces its
 * capture only once its live screen reads as the capture, on a first visit and on a
 * second, and stays so. A demo revealed on a screen still loading, or one the capture no
 * longer shows (an out-of-date capture, a script that no longer reaches it), fails.
 * Builds the demos and the site.
 *   bun run test:web:landing
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import * as z from "zod/mini";
import { Browser } from "./cdp";
import { serveSite } from "./site";

const WEBSITE = join(import.meta.dirname, "../../website");
/** Where each demo is, by the closest element with an id: the hero, the gallery's panels, Wire. */
const PLACES = ["top", "app-panel-0", "app-panel-1", "app-panel-2", "app-panel-3", "wire"];
/** As LiveTerminal.astro: the rows that may differ, a duration or a date. */
const MATCHING_ROWS = 0.95;
/** How long after its reveal a demo must still show its capture. */
const AFTER_MS = 1500;
const REVEAL_TIMEOUT_MS = 40_000;
const VISITS = 2;
/** How many differing rows a failure quotes. */
const QUOTED_ROWS = 5;

// Recorded in the page the moment a demo is revealed, then AFTER_MS later: the rows of its
// capture's stand-in and of the live screen that differ.
const recorder = `
window.reveals = [];
const rows = (root) => [...(root?.querySelectorAll(".xterm-rows > div") ?? [])]
  .map((row) => row.textContent.replaceAll("\\u00a0", " ").trimEnd());
const differing = (root) => {
  const capture = rows(root.querySelector(".stand"));
  const live = rows(root.querySelector("iframe")?.contentDocument);
  return capture.flatMap((line, i) => (live[i] === line ? [] : [{ row: i, capture: line, live: live[i] }]));
};
new MutationObserver((mutations) => {
  for (const { target } of mutations) {
    if (!(target instanceof HTMLElement) || !target.matches("[data-live].on") || target.revealed) continue;
    target.revealed = true;
    const reveal = { place: target.closest("[id]")?.id, demo: target.dataset.src.split("/")[2], rows: rows(target.querySelector(".stand")).length, at: differing(target) };
    setTimeout(() => window.reveals.push({ ...reveal, after: differing(target) }), ${AFTER_MS});
  }
}).observe(document, { subtree: true, attributes: true, attributeFilter: ["class"] });
`;
const Reveal = z.object({
  place: z.string(),
  demo: z.string(),
  rows: z.number(),
  at: z.array(z.object({ row: z.number(), capture: z.string(), live: z.optional(z.string()) })),
  after: z.array(z.object({ row: z.number(), capture: z.string(), live: z.optional(z.string()) })),
});

for (const [command, ...args] of [
  ["bun", "run", "demo"],
  ["bun", "run", "build"],
])
  if (spawnSync(command, args, { cwd: WEBSITE, stdio: "inherit" }).status !== 0)
    throw new Error(`website: ${[command, ...args].join(" ")} failed`);
const site = serveSite(join(WEBSITE, "dist"));
const failures: string[] = [];
try {
  await using browser = await Browser.start();
  // Wide enough for the demos to run; mdreader dates its files as its capture does.
  await browser.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await browser.send("Emulation.setLocaleOverride", { locale: "en-US" });
  await browser.send("Emulation.setTimezoneOverride", { timezoneId: "UTC" });
  await browser.send("Page.addScriptToEvaluateOnNewDocument", { source: recorder });
  const revealed = (place: string) =>
    `window.reveals.some((r) => r.place === ${JSON.stringify(place)})`;
  // The same browser each time: the second visit restores what the first left.
  for (let visit = 1; visit <= VISITS; visit++) {
    await browser.open(site.url.href);
    for (const place of PLACES) {
      // A gallery panel runs once picked; Wire and the hero, once near the viewport.
      const tab = place.replace("app-panel-", "app-tab-");
      await browser.evaluate(
        `document.getElementById(${JSON.stringify(place)}).scrollIntoView(), document.getElementById(${JSON.stringify(tab)})?.click()`,
      );
      await browser.waitFor(revealed(place), `${place}, visit ${visit}`, REVEAL_TIMEOUT_MS);
    }
    const reveals = z.array(Reveal).parse(await browser.evaluate("window.reveals"));
    for (const { place, demo, rows, at, after } of reveals) {
      const allowed = Math.floor(rows * (1 - MATCHING_ROWS));
      console.log(
        `visit ${visit} ${place} ${demo}: ${at.length} rows differ, ${after.length} later`,
      );
      for (const [when, differ] of [
        ["revealed", at],
        [`${AFTER_MS} ms later`, after],
      ] as const)
        if (differ.length > allowed)
          failures.push(
            `visit ${visit}: ${demo} ${when} on another screen than its capture:\n${JSON.stringify(differ.slice(0, QUOTED_ROWS), null, 2)}`,
          );
    }
  }
} finally {
  await site.stop(true);
}
if (failures.length) throw new Error(failures.join("\n"));
