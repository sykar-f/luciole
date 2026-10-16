/* eslint-disable no-magic-numbers -- Scripted browser proof coordinates and bounds. */
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
  if ((await browser.evaluate("devicePixelRatio")) !== Number(process.argv[2] ?? 1))
    throw new Error("Chrome did not start at the requested real device scale");
  await browser.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await browser.send("Browser.grantPermissions", {
    origin: server.url.origin,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  await browser.open(server.url.href + (process.argv[3] === "burst" ? "?burst" : ""));
  const wait = async (expression: string, label: string) => {
    try {
      return await browser.waitFor(expression, label);
    } catch (error) {
      console.error(
        label,
        await browser.evaluate(
          "JSON.stringify({state:probe.state(),events:probe.events.slice(-15),reports:probe.reports.slice(-8),published:probe.publication?.(),before:window.before})",
        ),
      );
      throw error;
    }
  };
  await wait("!!window.probe?.state().presented", "initial presentation");
  await browser.evaluate("{const r=probe.state().rect;probe.wheel(r.x+2,r.y+2,.75)}");
  await wait(
    "probe.state().presented?.rect.x===probe.state().rect.x && probe.state().presented?.fraction===.75",
    "editor presentation",
  );
  if (process.argv[3] === "attribution") {
    // Retain two fully presented canonical states, then inspect them together,
    // exactly as a delayed consumer drains the fixture's captured-frame queue.
    await browser.evaluate("probe.frames.length=0;probe.editor.scrollableViewport.set(0)");
    await wait(
      "probe.state().presented?.origin===0 && probe.state().presented?.fraction===0",
      "canonical top scrollbar",
    );
    await browser.evaluate("probe.editor.scrollableViewport.set(12)");
    await wait(
      "probe.state().presented?.origin===12 && probe.state().presented?.fraction===0",
      "canonical lower scrollbar",
    );
    const attribution = await browser.evaluate(`(()=>{
      const current=probe.state().bar, currentKeys=new Map(), presentedKeys=new Map();
      const currentErrors=[], presentedErrors=[], samples=[];
      for(const frame of probe.frames.filter(f=>f.phase===0)) {
        const a=currentKeys.get(current), b=presentedKeys.get(frame.bar);
        if(a && frame.thumb.some((value,i)=>value!==a[i])) currentErrors.push(frame.generation);
        if(b && frame.thumb.some((value,i)=>value!==b[i])) presentedErrors.push(frame.generation);
        currentKeys.set(current,frame.thumb);presentedKeys.set(frame.bar,frame.thumb);
        samples.push({generation:frame.generation,origin:frame.origin,committed:frame.bar,current});
      }
      return {currentErrors,presentedErrors,bars:presentedKeys.size,samples};
    })()`);
    console.log("canonical scrollbar attribution counterexample", attribution);
    if (
      !(await browser.evaluate(`(()=>{
      const frames=probe.frames.filter(f=>f.phase===0), current=probe.state().bar;
      const keys=new Map();let falsePositive=false;
      for(const frame of frames) {
        const old=keys.get(frame.bar);
        if(old && frame.thumb.some((value,i)=>value!==old[i])) return false;
        keys.set(frame.bar,frame.thumb);
        if(frame.bar!==current && frame.thumb.some((value,i)=>value!==frames.at(-1).thumb[i])) falsePositive=true;
      }
      return keys.size>1 && falsePositive;
    })()`))
    )
      throw new Error("The attribution diagnostic did not isolate a false positive");
    await browser.evaluate("probe.editor.scrollableViewport.set(.75)");
    await wait(
      "probe.state().presented?.origin===0 && probe.state().presented?.fraction===.75",
      "reset attribution diagnostic",
    );
  }
  if (process.argv[3] === "burst") {
    await browser.evaluate(
      "window.heldGeneration=probe.state().presented.generation;probe.burst()",
    );
    console.log(
      "held presentation",
      await browser.evaluate(
        "JSON.stringify({dpr:devicePixelRatio,displayed:probe.state().presented,published:probe.publication()})",
      ),
    );
    await browser.evaluate(
      "{const r=probe.state().rect;window.before=probe.state().position;probe.pointer('mousedown',r.x+2.5,r.y+2.1,1);probe.pointer('mousemove',r.x+7.5,r.y+r.height-.2,1)}",
    );
  } else if (process.argv[3] === "capture") {
    await browser.evaluate(
      "{const r=probe.state().rect;window.beforePaint=probe.state().presented.generation;probe.pointer('mousedown',r.x+1.5,r.y+2.1,1);probe.pointer('mousemove',r.x+7.5,r.y+4.1,1)}",
    );
    await wait(
      "probe.state().presented?.generation>window.beforePaint",
      "a paint during pointer capture",
    );
    await browser.evaluate(
      "{const r=probe.state().rect;probe.pointer('mouseup',r.x+7.5,r.y+4.1);window.before=probe.state().position;probe.pointer('mousedown',r.x+2.5,r.y+2.1,1);probe.pointer('mousemove',r.x+7.5,r.y+r.height-.2,1)}",
    );
  } else {
    await browser.evaluate(
      "{const r=probe.state().rect;probe.pointer('mousedown',r.x+1.5,r.y+2.1,1);probe.pointer('mousemove',r.x+7.5,r.y+4.1,1);probe.pointer('mouseup',r.x+7.5,r.y+4.1)}",
    );
    await browser.evaluate("probe.terminal.input('\\x1bc')");
    await wait("!!probe.state().copied", "fractional copy");
    await wait(
      "navigator.clipboard.readText().then(t=>t===probe.state().copied)",
      "clipboard copy",
    );
    await browser.evaluate(
      `(()=>{const r=probe.state().rect;window.before=probe.state().position;probe.pointer('mousedown',r.x+2.5,r.y+2.1,1);probe.pointer('mousemove',r.x+7.5,r.y+r.height-.2,1)})()`,
    );
  }
  await wait("probe.state().position>window.before+1", "new selection edge scroll after copy");
  if (process.argv[3] === "burst") {
    console.log(
      "accepted held-generation input",
      await browser.evaluate(
        "JSON.stringify({events:probe.events.slice(-4),reports:probe.reports.slice(-4)})",
      ),
    );
    if (
      !(await browser.evaluate(`(()=>{
      const generations=probe.publication().map(p=>p.generation);
      const inFlight=generations.filter(g=>g>window.heldGeneration);
      return probe.state().presented.generation===window.heldGeneration && inFlight.length<=7 &&
        probe.reports.some(r=>r.op==='pointer'&&r.action==='down'&&r.generation===window.heldGeneration);
    })()`))
    )
      throw new Error("The held presentation or bounded publication window changed");
    await browser.evaluate("probe.resume()");
    await wait("probe.state().presented.origin>0", "coalesced current state is presented");
  }
  console.log("editor press proof passed");
} finally {
  await server.stop(true);
}
