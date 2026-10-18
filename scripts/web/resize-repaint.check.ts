/* eslint-disable no-magic-numbers -- Real viewport resize regression. */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { build } from "../pty/harness";
import { Browser } from "./cdp";
import { pixelJourney } from "./pixel-test-process";
import { privateExample } from "./private-example";
import { serveSite } from "./site";

const TIMEOUT_MS = 180_000;
const CLEANUP_MS = 5_000;
const FOOTER = "LAST ROW FIT";

async function diagnose(browser: Browser, stage: Record<string, unknown>) {
  const snapshot = await browser
    .evaluate(`(()=>{
      const stage=${JSON.stringify(stage)}, rows=window.lucioleScreen?.();
      const columns=window.lucioleCells?.()?.[0]?.length;
      const screen=document.querySelector('.xterm-screen')?.getBoundingClientRect();
      return {viewport:[innerWidth,innerHeight], dpr:devicePixelRatio,
        grid:[columns,rows?.length], footer:rows?.at(-1)?.trimEnd(),
        rows:rows?.map(row=>row.trimEnd()),
        pageFailure:document.querySelector('#luciole.failed')?.textContent,
        screen:screen?.toJSON(),
        predicates:stage.initial ? {
          columns:stage.width===960 ? columns<stage.initial[0] : columns===stage.initial[0],
          rows:stage.width===960 ? rows?.length<stage.initial[1] : rows?.length===stage.initial[1],
          footer:rows?.at(-1)?.includes('${FOOTER}'),
          content:rows?.some(row=>row.includes('Row 0'))
        } : undefined};
    })()`)
    .catch((error: unknown) => ({ unavailable: String(error) }));
  console.error(JSON.stringify({ resizeDiagnostic: stage, snapshot }));
}

async function verify(dpr: number) {
  using directory = privateExample("notes", "luciole-resize-repaint-");
  await Bun.write(
    join(directory.app, "app/layout.tsx"),
    `"use client";
import type { LayoutProps } from "@luciole-sh/core/client";
export default function Layout({children}: LayoutProps) {
  return <box width="100%" height="100%" flexDirection="column">
    <box flexGrow={1}>{children}</box>
    <text height={1} flexShrink={0}>${FOOTER}</text>
  </box>;
}`,
  );
  await Bun.write(
    join(directory.app, "app/page.tsx"),
    `export default function Page() {
  return <scrollbox height="100%" width="100%">{Array.from({length:100},(_,i)=><text key={i} height={1}>Row {i}</text>)}</scrollbox>;
}`,
  );
  build(directory.app, ["--web-local"]);
  const files = serveSite(join(directory.app, ".luciole/web"));
  try {
    await using browser = await Browser.start({ deviceScaleFactor: dpr });
    for (const reduced of [false, true]) {
      await browser.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" }],
      });
      for (const loaded of [false, true]) {
        await browser.send("Emulation.setDeviceMetricsOverride", {
          width: 1280,
          height: 900,
          deviceScaleFactor: 0,
          mobile: false,
        });
        await browser.open(`${files.url}?restore=off`);
        await browser.waitFor(
          `window.lucioleScreen?.().at(-1)?.includes('${FOOTER}') ${loaded ? "&& window.lucioleScreen().some(row=>row.includes('Row 0'))" : ""}`,
          "initial footer",
        );
        const initial = await browser.evaluate("[lucioleCells()[0].length,lucioleScreen().length]");
        for (const [width, height] of [
          [960, 720],
          [1280, 900],
        ]) {
          await diagnose(browser, {
            stage: "before-resize",
            dpr,
            reduced,
            loaded,
            width,
            height,
            initial,
          });
          await browser.send("Emulation.setDeviceMetricsOverride", {
            width,
            height,
            deviceScaleFactor: 0,
            mobile: false,
          });
          try {
            await browser.waitFor(
              `(()=>{
            const rows=window.lucioleScreen?.(), initial=${JSON.stringify(initial)};
            const columns=window.lucioleCells?.()[0].length;
            return rows && (columns${width === 960 ? "<" : "==="}initial[0]) &&
              (rows.length${width === 960 ? "<" : "==="}initial[1]) && rows.at(-1).includes('${FOOTER}') &&
              rows.some(row=>row.includes('Row 0'));
          })()`,
              "resized application and footer",
            );
          } catch (error) {
            await diagnose(browser, {
              stage: "after-resize",
              dpr,
              reduced,
              loaded,
              width,
              height,
              initial,
            });
            throw error;
          }
          const proof = await browser.evaluate(`(async()=>{
            await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
            const rows=lucioleScreen(), screen=document.querySelector('.xterm-screen').getBoundingClientRect();
            return {dpr:devicePixelRatio,viewport:[innerWidth,innerHeight],rows:rows.length,
              columns:lucioleCells()[0].length,footer:rows.at(-1).trim(),
              inside:screen.bottom<=innerHeight && screen.right<=innerWidth};
          })()`);
          console.log(JSON.stringify({ dpr, reduced, loaded, width, height, proof }));
          expect(proof).toMatchObject({
            dpr,
            viewport: [width, height],
            footer: FOOTER,
            inside: true,
          });
        }
      }
    }
  } finally {
    await files.stop(true);
  }
}
if (process.argv.includes("--probe")) {
  await verify(Number(process.argv.at(-1)));
} else {
  for (const dpr of [1, 2]) {
    test(
      `live resize repaints the last row at real DPR ${dpr}`,
      () => pixelJourney(import.meta.path, ["--probe", String(dpr)], TIMEOUT_MS, dpr),
      TIMEOUT_MS + CLEANUP_MS,
    );
  }
}
