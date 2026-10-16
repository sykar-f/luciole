/* eslint-disable no-magic-numbers -- Browser viewport and terminal layout proof. */
/** Explicit real-device-scale proof of the runtime host, standalone and framed. */
import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import * as z from "zod/mini";
import { build, ROOT } from "../pty/harness";
import { Browser } from "./cdp";
import { pixelJourney } from "./pixel-test-process";
import { privateExample } from "./private-example";
import { serveSite } from "./site";

const TIMEOUT_MS = 180_000;
const CLEANUP_MS = 5_000;
const FOOTER = "LAST ROW FIT";

async function verify(dpr: number) {
  using directory = privateExample("notes", "luciole-fit-padding-");
  // A deterministic last-row marker, rendered by the real Application and runtime.
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
  const website = serveSite(join(ROOT, "website/dist"));
  const host = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/host")
        return new Response(
          `<!doctype html><body style="margin:0"><iframe src="/index.html?${url.searchParams}" style="position:fixed;inset:24px;width:calc(100% - 48px);height:calc(100% - 48px);border:0"></iframe>`,
          { headers: { "content-type": "text/html" } },
        );
      // The built landing's actual capture component, with our deterministic app
      // behind its iframe. Preserve each capture's columns/rows query unchanged.
      if (url.pathname === "/landing") return fetch(new URL("/examples/", website.url));
      if (url.pathname.startsWith("/demo/"))
        return fetch(
          new URL("/" + url.pathname.split("/").slice(3).join("/") + url.search, files.url),
        );
      if (url.pathname.startsWith("/_astro/") || url.pathname.startsWith("/fonts/"))
        return fetch(new URL(url.pathname, website.url));
      const response = await fetch(new URL(url.pathname + url.search, files.url));
      return response.ok ? response : fetch(new URL(url.pathname + url.search, website.url));
    },
  });
  const failures: string[] = [];
  try {
    await using browser = await Browser.start({ deviceScaleFactor: dpr });
    for (const reduced of [false, true]) {
      // Reduced motion disables the pixel controller in the unmodified runtime.
      await browser.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" }],
      });
      for (const framed of [false, true]) {
        for (const fixed of [false, true]) {
          const context = framed ? 'document.querySelector("iframe").contentWindow' : "window";
          for (const [width, height] of [
            [1280, 900],
            [960, 720],
          ]) {
            // Every measurement starts with a new document; live resize has its own mission.
            await browser.send("Emulation.setDeviceMetricsOverride", {
              width,
              height,
              deviceScaleFactor: 0,
              mobile: false,
            });
            const query = fixed ? "columns=100&rows=30&restore=off" : "restore=off";
            await browser.open(`${framed ? host.url + "host" : files.url}?${query}`);
            await browser.waitFor(
              `${context}.lucioleScreen?.().at(-1)?.includes('${FOOTER}')`,
              "the application's last row",
            );
            const proof = z.object({ errors: z.array(z.string()), measurement: z.unknown() }).parse(
              await browser.evaluate(`(async()=>{
              const w=${context};
              await new Promise(r=>w.requestAnimationFrame(()=>w.requestAnimationFrame(r)));
              const host=w.document.querySelector('#luciole'), screen=w.document.querySelector('.xterm-screen');
              const h=host.getBoundingClientRect(), s=screen.getBoundingClientRect(), css=w.getComputedStyle(host);
              const rows=w.lucioleScreen(), bottom=h.bottom-parseFloat(css.paddingBottom), right=h.right-parseFloat(css.paddingRight);
              const errors=[];
              if(w.devicePixelRatio!==${dpr}) errors.push('wrong real DPR');
              if(s.top!==8 || s.left!==8) errors.push('visible margin changed');
              if(s.bottom>bottom || s.right>right || s.bottom>w.innerHeight || s.right>w.innerWidth) errors.push('screen exceeds content box');
              if(!rows.at(-1).includes('${FOOTER}')) errors.push('last row marker absent');
              const point=w.document.elementFromPoint(s.left+1,s.bottom-.5);
              if(!point || !host.contains(point)) errors.push('last row clipped');
              return {errors,measurement:{dpr:w.devicePixelRatio,viewport:[w.innerWidth,w.innerHeight],host:{height:h.height,padding:css.padding},screen:{x:s.x,y:s.y,width:s.width,height:s.height,bottom:s.bottom},last:rows.at(-1)}};
            })()`),
            );
            console.log(JSON.stringify({ dpr, reduced, framed, fixed, width, height, ...proof }));
            failures.push(...proof.errors);
          }
        }
      }
    }
    // Compare the real built LiveTerminal capture with the runtime in its iframe.
    // Reduced motion holds the capture still and disables fractional presentation.
    await browser.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    for (const [width, height] of [
      [1280, 900],
      [1240, 900],
      [960, 720],
    ]) {
      await browser.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 0,
        mobile: false,
      });
      await browser.open(host.url + "landing");
      await browser.evaluate(
        `[...document.querySelectorAll('[data-live]')].find(r=>r.getBoundingClientRect().width>0)?.scrollIntoView()`,
      );
      await browser.waitFor(
        `[...document.querySelectorAll('[data-live]')].some(r=>r.querySelector('.stand .xterm-screen')?.getBoundingClientRect().width>0)`,
        "the landing's capture grid",
      );
      await browser.evaluate(`{
        window.fitCapture=[...document.querySelectorAll('[data-live]')].find(r=>r.querySelector('.stand .xterm-screen')?.getBoundingClientRect().width>0);
        fitCapture.dispatchEvent(new Event('live:start'));
      }`);
      await browser.waitFor(
        `window.fitCapture?.querySelector('iframe')?.contentWindow.lucioleScreen?.().at(-1)?.includes('${FOOTER}')`,
        "the runtime inside the landing capture",
      );
      const proof = z.object({ errors: z.array(z.string()), measurement: z.unknown() }).parse(
        await browser.evaluate(`(()=>{
          const root=fitCapture, holder=root.querySelector('.stand'), frame=root.querySelector('iframe');
          const capture=holder.querySelector('.xterm-screen').getBoundingClientRect();
          const live=frame.contentDocument.querySelector('.xterm-screen').getBoundingClientRect();
          const captureRows=holder.lucioleScreen(), liveRows=frame.contentWindow.lucioleScreen();
          const columns=JSON.parse(root.querySelector('[data-stand]').textContent).columns;
          const liveColumns=frame.contentWindow.lucioleCells()[0].length;
          const errors=[];
          if(devicePixelRatio!==${dpr} || frame.contentWindow.devicePixelRatio!==${dpr}) errors.push('wrong capture DPR');
          if(capture.width!==live.width || capture.height!==live.height || captureRows.length!==liveRows.length || columns!==liveColumns) errors.push('capture and runtime grids differ');
          if(capture.left-holder.parentElement.getBoundingClientRect().left!==8 || capture.top-holder.parentElement.getBoundingClientRect().top!==8) errors.push('capture margin changed');
          return {errors,measurement:{room:{capture:getComputedStyle(holder).width,live:frame.contentWindow.getComputedStyle(frame.contentDocument.querySelector("#luciole")).width},capture:[capture.width,capture.height,captureRows.length,columns],live:[live.width,live.height,liveRows.length,liveColumns]}};
        })()`),
      );
      console.log(JSON.stringify({ dpr, capture: true, width, height, ...proof }));
      failures.push(...proof.errors);
    }
  } finally {
    await files.stop(true);
    await host.stop(true);
    await website.stop(true);
  }
  expect(failures).toEqual([]);
}

if (process.argv.includes("--probe")) {
  await verify(Number(process.argv.at(-1)));
} else {
  // Orch runs tests in a fresh checkout: the gate's ignored dist is not an input.
  beforeAll(() => {
    for (const args of [
      ["install", "--frozen-lockfile"],
      ["x", "astro", "sync"],
      ["run", "build"],
    ]) {
      const result = Bun.spawnSync([process.execPath, ...args], {
        cwd: join(ROOT, "website"),
        stdio: ["ignore", "inherit", "inherit"],
      });
      if (result.exitCode !== 0) throw new Error(`website: ${args.join(" ")} failed`);
    }
  }, TIMEOUT_MS);
  for (const dpr of [1, 2]) {
    test(
      `runtime fits its last row at real DPR ${dpr}`,
      () => pixelJourney(import.meta.path, ["--probe", String(dpr)], TIMEOUT_MS, dpr),
      TIMEOUT_MS + CLEANUP_MS,
    );
  }
}
