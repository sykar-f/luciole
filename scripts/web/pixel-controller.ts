/* eslint-disable no-magic-numbers -- Scripted browser proof coordinates and bounds. */
import { expect } from "bun:test";
import * as z from "zod/mini";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { defaultCache } from "../../packages/core/src/compile";
import { prepareWebRuntime, webRuntimeDirectory } from "../../packages/core/src/web-runtime";
import { opentuiWasm } from "../../packages/core/src/web/opentui/plugin";
import { browserNode } from "../../packages/core/src/web/node/plugin";
import { Browser } from "./cdp";

await prepareWebRuntime();
const runtime = await webRuntimeDirectory();
const patch = await Bun.file(
  import.meta.dir + "/../../packages/core/web/opentui-v0.5.12.patch",
).arrayBuffer();
const key = createHash("sha256").update(new Uint8Array(patch)).digest("hex").slice(0, 16);
const checkout = join(defaultCache(), "web", `opentui-v0.5.12-${key}`);
const build = await Bun.build({
  entrypoints: [import.meta.dir + "/pixel-controller-page.ts"],
  target: "browser",
  format: "esm",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  plugins: [
    opentuiWasm,
    {
      name: "fixture-sources",
      setup(builder) {
        builder.onResolve({ filter: /^@opentui\/core$/ }, () => ({
          path: join(checkout, "packages/core/src/index.ts"),
        }));
      },
    },
    browserNode,
  ],
});
if (!build.success) throw new Error(build.logs.map((log) => log.message).join("\n"));
const script = await build.outputs[0]?.text();
const css = await Bun.file(join(runtime, "xterm.css")).text();
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/fixture.js")
      return new Response(script, { headers: { "content-type": "text/javascript" } });
    if (path === "/opentui.wasm") return new Response(Bun.file(join(runtime, "opentui.wasm")));
    return new Response(
      `<style>${css}body{margin:0;background:#000}</style><script type="module" src="/fixture.js"></script>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});
try {
  await using browser = await Browser.start();
  await browser.send("Emulation.setDeviceMetricsOverride", {
    width: 900,
    height: 600,
    deviceScaleFactor: Number(process.argv[2] ?? 1),
    mobile: false,
  });
  const wait = async (expression: string, label: string) => {
    try {
      return await browser.waitFor(expression, label);
    } catch (error) {
      console.error(
        label,
        await browser.evaluate(
          "window.probe ? {state:probe.state(),operations:probe.operations(),reports:probe.reports.slice(-6),events:probe.events.slice(-12)} : 'no probe'",
        ),
      );
      throw error;
    }
  };
  await browser.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await browser.send("Browser.grantPermissions", {
    origin: server.url.origin,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  await browser.open(server.url.href);
  await wait("!!window.probe?.state().presented", "the negotiated ScrollBox presentation");
  const bands = z
    .object({
      errors: z.array(z.string()),
      checked: z.number(),
      thumbs: z.number(),
      position: z.number(),
    })
    .parse(
      await browser.evaluate(`(async () => {
    const pause = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const first = probe.state();
    const rect = first.left.rect, H = first.cellHeight;
    const errors = []; let checked = 0, previous = 0; const thumbs=new Set();
    const bar = JSON.stringify(first.bar);
    probe.frames.length = 0;
    for (const direction of [1, -1]) {
      for (let i = 0; i < 48; i++) {
        probe.wheel(rect.x+rect.width-2, rect.y+2.5, direction*.25);
        await pause(); await pause();
        const state = probe.state();
        if (JSON.stringify(state.bar)!==bar) errors.push('scrollbar moved');
        for(const frame of probe.frames.splice(0)) {
          thumbs.add(JSON.stringify(frame.thumb));
          const position=frame.origin+frame.phase;
          if(direction*(position-previous)<-1e-6 || Math.abs(position-previous)>.25+1/H+1e-6) errors.push('discontinuity:'+previous+'/'+position);
          previous=position;
          for(let y=Math.ceil(rect.y*H);y<Math.floor((rect.y+rect.height)*H);y++) {
            const row=frame.origin+Math.floor((y-rect.y*H+Math.round(frame.phase*H))/H);
            const hex=probe.color(row).slice(1);
            const expected=[0,2,4].map(at=>parseInt(hex.slice(at,at+2),16));
            const actual=frame.column.slice(y*3,y*3+3);
            if(expected.some((v,i)=>v!==actual[i])) {errors.push('band:'+row+':'+y+':'+actual+'/'+expected);break;}
          }
          checked++;
        }
      }
    }
    return {errors,checked,thumbs:thumbs.size,position:probe.state().left.position};
  })()`),
    );
  expect(bands).toMatchObject({ errors: [], position: 0 });
  expect(bands.checked).toBeGreaterThanOrEqual(96);
  expect(bands.thumbs).toBeGreaterThan(1);
  console.log("continuity", bands);
  expect(
    await browser.evaluate(
      `(async()=>{const before=probe.state().presented.generation;probe.r.requestRender();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return probe.state().presented.generation===before})()`,
    ),
  ).toBe(true);
  console.log(
    "240-row precise dispatch maximum ms",
    await browser.evaluate("probe.state().maxInputMs"),
  );

  await browser.evaluate("probe.wheel(20,3,.375)");
  await wait("probe.state().presented?.fraction > .3", "a resting fractional presentation");
  await browser.evaluate(
    "probe.events.length=0; {const r=probe.state().left.rect;probe.pointer('mousemove',r.x+1.5,r.y+r.height-.125)}",
  );
  await wait("probe.events.some(e=>e.type==='over')", "entering-edge hover");
  expect(
    await browser.evaluate(
      "probe.events.filter(e=>e.type==='over').at(-1)?.id === 'row-'+probe.state().left.rect.height",
    ),
  ).toBe(true);
  await browser.evaluate(
    "probe.events.length=0; {const r=probe.state().left.rect; probe.pointer('mousemove',r.x+1.5,r.y+1.9)}",
  );
  await wait("probe.events.some(e=>e.type==='over')", "fractional hover");
  expect(await browser.evaluate("probe.events.filter(e=>e.type==='over').at(-1)?.id")).toBe(
    "row-2",
  );
  expect(await browser.evaluate("probe.state().effect")).toBe("over row-2");
  await browser.evaluate(
    "{const r=probe.state().left.rect;probe.pointer('mousedown',r.x+1.5,r.y+1.9,1);probe.pointer('mouseup',r.x+1.5,r.y+1.9)}",
  );
  await wait("probe.state().effect==='down row-2'", "visible click effect");
  await browser.evaluate("probe.selectable(false)");
  await browser.evaluate(
    "{const r=probe.state().left.rect;probe.pointer('mousedown',r.x+1.5,r.y+1.9,1);probe.pointer('mousemove',r.x+1.5,r.y+1.9,1);probe.pointer('mousemove',r.x+6.5,r.y+2.9,1);probe.pointer('mouseup',r.x+6.5,r.y+2.9)}",
  );
  await wait("probe.events.some(e=>e.type==='drop')", "application drop");
  expect(await browser.evaluate("probe.events.some(e=>e.id==='row-2'&&e.type==='down')")).toBe(
    true,
  );
  expect(
    await browser.evaluate(
      "probe.events.some(e=>e.id==='row-3'&&e.type==='drop'&&e.source==='row-2')",
    ),
  ).toBe(true);
  await browser.evaluate(
    "probe.selectable(true); {const r=probe.state().left.rect;probe.pointer('mousedown',r.x+.5,r.y+1.9,1);probe.pointer('mousemove',r.x+6.5,r.y+2.9,1);probe.pointer('mouseup',r.x+6.5,r.y+2.9)}",
  );
  await browser.evaluate("probe.terminal.input('\\x03')");
  await wait("!!probe.state().copied", "application selection copy");
  expect(await browser.evaluate("probe.state().copied")).toEqual("ROW 002 selectable\nROW 003");
  await wait(
    "navigator.clipboard.readText().then(text=>text===probe.state().copied)",
    "browser clipboard copy",
  );
  await browser.evaluate("probe.terminal.input('\\x1b[B')");
  await wait("probe.state().left.position > 1", "focused keyboard scroll");
  // A disjoint viewport is selected by an ordinary move before precise wheel input.
  await browser.evaluate("probe.pointer('mousemove',30,3)");
  await wait("probe.state().presented?.rect.x > 25", "disjoint viewport handover");
  await browser.evaluate("probe.wheel(30,3,.375)");
  await wait("probe.state().right.position > .3", "precise wheel in the second viewport");
  await browser.evaluate("probe.pointer('mousemove',3,3)");
  await wait("probe.state().presented?.rect.x < 25", "handover back to the long viewport");
  await browser.evaluate(
    "window.nestedGeneration=probe.state().presented.generation;probe.nested()",
  );
  await wait(
    "probe.state().nested.rect.height > 0 && probe.state().presented?.generation>window.nestedGeneration",
    "nested viewport presentation",
  );
  await browser.evaluate("{const r=probe.state().nested.rect;probe.wheel(r.x+2,r.y+1.5,.375)}");
  await wait(
    "probe.state().nested.position > 0 && probe.state().presented?.rect.height===probe.state().nested.rect.height",
    "nested precise wheel handover",
  );
  expect(await browser.evaluate("Number.isInteger(probe.state().left.position)")).toBe(true);
  await browser.evaluate(
    "{const r=probe.state().nested.rect;probe.wheel(r.x+2,r.y+1.5,probe.state().nested.max+.25)}",
  );
  await wait(
    "probe.state().nested.position===probe.state().nested.max && !Number.isInteger(probe.state().left.position)",
    "nested bound remainder to parent",
  );
  await wait(
    "probe.state().presented?.rect.height===probe.state().left.rect.height",
    "parent region after nested bound handover",
  );

  await browser.evaluate("probe.resetNested()");
  await wait("probe.state().presented?.fraction===0", "canonical parent before burst");
  await browser.evaluate(
    "{const r=probe.state().nested.rect;probe.wheel(r.x+2,r.y+1.5,.375);probe.wheel(r.x+2,r.y+1.5,probe.state().nested.max+.25)}",
  );
  await wait(
    "probe.state().nested.position===probe.state().nested.max && probe.state().presented?.fraction>.5 && probe.state().presented?.rect.height===probe.state().left.rect.height",
    "coalesced nested burst remainder",
  );
  await browser.evaluate("probe.popup()");
  await wait("!probe.state().presented", "canonical release before popup presentation");
  await browser.evaluate("window.popupFrame=probe.r.frameId;probe.closePopup()");
  await wait("probe.r.frameId>window.popupFrame", "canonical paint after closing popup");
  await browser.evaluate("probe.pointer('mousemove',20,3)");
  await wait("!!probe.state().presented", "rebuilt presentation");
  await browser.evaluate(
    "{const r=probe.state().left.rect;probe.wheel(r.x+r.width-2,r.y+2.5,.375)}",
  );
  await wait("probe.state().presented?.fraction>.3", "fraction before resize");
  await browser.evaluate("probe.resize()");
  await wait(
    "probe.state().presented?.fraction>.3 && probe.terminal.rows===17",
    "resize rediscovery",
  );
  await browser.evaluate("probe.loseContext()");
  await wait(
    "probe.reports.some(r=>r.op==='capability'&&r.reason==='no-gpu') && !probe.state().presented && Number.isInteger(probe.state().left.position)",
    "context-loss canonical fallback",
  );
  for (const scenario of ["optOut", "reduced", "noHost"]) {
    await browser.send("Emulation.setEmulatedMedia", {
      features: [
        {
          name: "prefers-reduced-motion",
          value: scenario === "reduced" ? "reduce" : "no-preference",
        },
      ],
    });
    await browser.open(server.url.href + (scenario === "reduced" ? "" : "?" + scenario));
    await wait("!!window.probe", scenario + " fixture");
    await browser.evaluate("probe.wheel(20,3,.375)");
    expect(await browser.evaluate("probe.state().left.position")).toBe(0);
    await browser.evaluate("probe.wheel(20,3,2)");
    await wait("probe.state().left.position > 0", scenario + " row wheel");
    expect(
      await browser.evaluate(
        "Number.isInteger(probe.state().left.position) && !probe.state().presented",
      ),
    ).toBe(true);
    if (scenario === "reduced") {
      await browser.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
      });
      await wait("!!probe.state().presented", "rediscovery after reduced motion ends");
    }
  }
  await browser.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
  });
  await browser.open(server.url.href);
  await wait("!!window.probe?.state().presented", "native-selection fixture");
  await browser.evaluate(
    "{const r=probe.state().left.rect;probe.wheel(r.x+r.width-2,r.y+2.5,.375)}",
  );
  await wait("probe.state().presented?.fraction > .3", "fraction before native selection");
  await browser.evaluate(
    "{const r=probe.state().left.rect,mac=navigator.platform.includes('Mac');probe.pointer('mousedown',r.x+1.5,r.y+1.5,1,!mac,mac);probe.pointer('mousemove',r.x+8.5,r.y+2.5,1,!mac,mac);probe.pointer('mouseup',r.x+8.5,r.y+2.5,0,!mac,mac)}",
  );
  await wait("!probe.state().presented", "native selection's canonical release");
  await wait("!!probe.state().nativeSelection", "native selection replay");
  await browser.evaluate(
    "probe.terminal.options.macOptionClickForcesSelection=false;probe.events.length=0;{const r=probe.state().left.rect;probe.pointer('mousedown',r.x+1.5,r.y+1.5,1,false,true);probe.pointer('mouseup',r.x+1.5,r.y+1.5,0,false,true)}",
  );
  await wait("probe.events.some(e=>e.type==='down')", "ordinary Alt click after release");
  await browser.evaluate("probe.pointer('mousemove',3,3)");
  await wait("!!probe.state().presented", "presentation after native selection");
  console.log("pixel controller browser proof passed");
} finally {
  await server.stop(true);
}
