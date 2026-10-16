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
  entrypoints: [import.meta.dir + "/pixel-markdown-editor-page.ts"],
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
  await using browser = await Browser.start({ deviceScaleFactor: Number(process.argv[2] ?? 1) });
  await browser.send("Emulation.setDeviceMetricsOverride", {
    width: 900,
    height: 600,
    deviceScaleFactor: 0,
    mobile: false,
  });
  await browser.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await browser.send("Browser.grantPermissions", {
    origin: server.url.origin,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  await browser.open(server.url.href);
  const wait = async (expression: string, label: string) => {
    try {
      return await browser.waitFor(expression, label);
    } catch (error) {
      console.error(
        label,
        await browser.evaluate(
          "JSON.stringify({state:probe.state(),events:probe.events.slice(-15),reports:probe.reports.slice(-8),before:window.before})",
        ),
      );
      throw error;
    }
  };
  await wait("!!window.probe?.state().presented", "the other viewport presentation");
  expect(await browser.evaluate("devicePixelRatio")).toBe(Number(process.argv[2] ?? 1));
  expect(await browser.evaluate("probe.state().presented.rect.x")).toBeLessThan(20);
  await browser.evaluate("probe.terminal.input('\\x1b[B')");
  await wait("probe.state().otherPosition===1", "ScrollBox still owns its Down key");
  await browser.evaluate("probe.terminal.input('\\x1b[A')");
  await wait("probe.state().otherPosition===0", "ScrollBox Up key");
  await browser.evaluate("{const r=probe.state().rect;probe.wheel(r.x+2,r.y+2,.375)}");
  await wait(
    "probe.state().presented?.rect.x===probe.state().rect.x && probe.state().position===.375",
    "the editor's first precise wheel",
  );
  expect(await browser.evaluate("probe.state().presented.origin")).toBe(0);

  await browser.evaluate(`(async()=>{
      const pause=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      const waitFrame=async()=>{await pause();await pause();};
      const refs=[], referenceTrace=[];
      for(let row=0;row<=12;row++) {
        probe.editor.scrollableViewport.set(row); await waitFrame();
        const sample=probe.capture();
        refs.push(sample);
        referenceTrace.push({requested:row,presented:probe.state().presented,
          cellHeight:probe.state().cellHeight,length:sample.content.length,
          prefix:sample.content.slice(0,48)});
      }
      probe.editor.scrollableViewport.set(0);await waitFrame();
      const start=probe.state(), H=start.cellHeight;
      const stride=refs[0].content.length/(start.rect.height*H);
      const errors=[],thumbs=new Map();let checked=0,previous=0,fractionalThumbs=0,previousBar=start.bar,previousOrigin=0;
      probe.frames.length=0;
      window.advanceEditorProof = async(direction) => { for(let step=0;step<24;step++) {
        probe.wheel(start.rect.x+2,start.rect.y+2,direction*.25); await waitFrame();
        for(const frame of probe.frames.splice(0)) {
          const position=frame.origin+frame.phase;
          if(direction*(position-previous)<-1e-6 || Math.abs(position-previous)>.25+1/H+1e-6)
            errors.push('discontinuity:'+previous+'/'+position);
          previous=position;
          const offset=Math.round(frame.phase*H)*stride;
          const reference=refs[frame.origin].content.slice(offset).concat(refs[frame.origin+1]?.content.slice(-H*stride,-H*stride+offset)||[]);
          const mismatch=frame.content.findIndex((v,i)=>v!==reference[i]);
          if(mismatch>=0) errors.push('content:'+position+':'+mismatch+':'+frame.content[mismatch]+'/'+reference[mismatch]);
          const bar=frame.bar, old=thumbs.get(bar);
          if(old && frame.thumb.some((v,i)=>v!==old[i])) errors.push('translated scrollbar:'+position);
          if(bar!==previousBar && frame.origin===previousOrigin) fractionalThumbs++;
          previousBar=bar;previousOrigin=frame.origin;
          thumbs.set(bar,frame.thumb);checked++;
        }
      }
      };
      window.editorReferenceTrace = () => referenceTrace;
      window.finishEditorProof = () => ({checked,errors:errors.slice(0,10),thumbs:thumbs.size,fractionalThumbs});
      return true;
    })()`);
  for (const direction of [1, 1, -1, -1])
    await browser.evaluate(`advanceEditorProof(${direction})`);
  const continuity = z
    .object({
      checked: z.number(),
      errors: z.array(z.string()),
      thumbs: z.number(),
      fractionalThumbs: z.number(),
    })
    .parse(await browser.evaluate("finishEditorProof()"));
  console.log("editor continuity", continuity);
  console.log("canonical reference attribution", await browser.evaluate("editorReferenceTrace()"));
  expect(continuity.errors).toEqual([]);
  expect(continuity.checked).toBeGreaterThanOrEqual(96);
  expect(continuity.thumbs).toBeGreaterThan(1);
  expect(continuity.fractionalThumbs).toBeGreaterThan(0);
  await browser.evaluate("{const r=probe.state().rect;probe.wheel(r.x+2,r.y+2,.75)}");
  await wait("probe.state().presented?.fraction===.75", "fraction before click");
  await browser.evaluate(
    "{const r=probe.state().rect;probe.pointer('mousedown',r.x+4.5,r.y+.1,1);probe.pointer('mouseup',r.x+4.5,r.y+.1)}",
  );
  await wait("probe.editor.focused", "editor focus by click");
  expect(await browser.evaluate("probe.state().selection.head")).toEqual({ block: 0, offset: 4 });
  expect(await browser.evaluate("probe.state().cursor")).toBe(1);
  await browser.evaluate("probe.terminal.input('\\x1b[B')");
  await wait("probe.state().selection.head.block===1", "editor Down moves the cursor");
  expect(await browser.evaluate("probe.state().position")).toBe(0.75);
  await browser.evaluate("probe.terminal.input('\\x1b[A')");
  await wait("probe.state().selection.head.block===0", "editor Up moves the cursor");
  // Keep one browser task: the wheel changes logical state before a new frame
  // can be presented. The following drag must still name the old document row.
  expect(
    await browser.evaluate(`(()=>{
    const r=probe.state().rect;
    probe.pointer('mousedown',r.x+2.5,r.y+2.1,1);
    probe.wheel(r.x+2,r.y+2,2);
    probe.pointer('mousemove',r.x+7.5,r.y+4.1,1);
    const result={head:probe.state().selection.head, origin:probe.state().presented.origin};
    probe.pointer('mouseup',r.x+7.5,r.y+4.1);
    return result;
  })()`),
  ).toEqual({ head: { block: 2, offset: 7 }, origin: 0 });
  await browser.evaluate(
    "probe.editor.controller.moveTo({block:0,offset:4});probe.editor.scrollableViewport.set(.75)",
  );
  await wait(
    "probe.state().presented?.origin===0 && probe.state().presented?.fraction===.75",
    "reset document presentation before the next drag",
  );
  // A distinct cell avoids the editor's multi-click selection gestures.
  await browser.evaluate(
    "{const r=probe.state().rect;probe.pointer('mousedown',r.x+1.5,r.y+2.1,1);probe.pointer('mousemove',r.x+7.5,r.y+4.1,1)}",
  );
  await wait("probe.state().selection.head.block===2", "fractional document drag");
  expect(await browser.evaluate("probe.state().selection.anchor")).toEqual({ block: 1, offset: 1 });
  await browser.evaluate("{const r=probe.state().rect;probe.wheel(r.x+2,r.y+2,2)}");
  await wait("probe.state().presented?.origin===2", "scrolled document presented during selection");
  await browser.evaluate(
    "{const r=probe.state().rect;probe.pointer('mousemove',r.x+7.5,r.y+4.1,1);probe.pointer('mouseup',r.x+7.5,r.y+4.1)}",
  );
  expect(await browser.evaluate("probe.state().selection.anchor")).toEqual({ block: 1, offset: 1 });
  expect(await browser.evaluate("probe.state().selection.head")).toEqual({ block: 3, offset: 7 });
  await browser.evaluate("probe.terminal.input('\\x1bc')");
  await wait("!!probe.state().copied", "copy while fractional");
  expect(await browser.evaluate("probe.state().copied")).toBe(
    "OW 001 selectable\n\nROW 002 selectable\n\nROW 003",
  );
  await wait(
    "navigator.clipboard.readText().then(t=>t===probe.state().copied)",
    "browser clipboard",
  );
  await browser.evaluate(
    "{const r=probe.state().rect;probe.pointer('mousedown',r.x+2.5,r.y+2.1,1);probe.pointer('mousemove',r.x+7.5,r.y+r.height-.2,1);window.anchor=probe.state().selection.anchor;window.before=probe.state().position}",
  );
  await wait("probe.state().position>window.before+1", "selection edge auto-scroll");
  expect(
    await browser.evaluate(
      "JSON.stringify(probe.state().selection.anchor)===JSON.stringify(window.anchor)",
    ),
  ).toBe(true);
  await browser.evaluate(
    "{const r=probe.state().rect;probe.pointer('mouseup',r.x+7.5,r.y+r.height-.2)}",
  );
  console.log("pixel markdown editor browser proof passed");
} finally {
  await server.stop(true);
}
