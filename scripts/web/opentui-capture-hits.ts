/* eslint-disable no-magic-numbers -- Scripted browser proof coordinates and bounds. */
import { expect } from "bun:test";
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
  const pixelOff = process.argv[3] === "optOut";
  await browser.open(server.url.href + (pixelOff ? "?optOut" : ""));
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
  await wait(
    pixelOff ? "!!window.probe" : "!!window.probe?.state().presented",
    "initial presentation",
  );
  if (!pixelOff)
    await browser.evaluate("{const r=probe.state().rect;probe.wheel(r.x+2,r.y+2,.75)}");
  await wait(
    pixelOff
      ? "true"
      : "probe.state().presented?.rect.x===probe.state().rect.x && probe.state().presented?.fraction===.75",
    "editor presentation",
  );
  expect(await browser.evaluate("devicePixelRatio")).toBe(Number(process.argv[2]));
  await browser.evaluate(
    "{const r=probe.state().rect;window.beforePaint=probe.r.captureHitMap().frameId;probe.pointer('mousedown',r.x+1.5,r.y+2.1,1);probe.pointer('mousemove',r.x+7.5,r.y+4.1,1)}",
  );
  await wait(
    "probe.r.captureHitMap().frameId>window.beforePaint",
    "a paint during pointer capture",
  );
  const result = await browser.evaluate(`(()=>{
    const r=probe.state().rect;
    const frame=probe.r.captureHitMap().frameId;
    const hit=probe.r.hitTest(Math.floor(r.x+r.width+.5),Math.floor(r.y+2.1));
    probe.pointer('mouseup',r.x+7.5,r.y+4.1);
    window.before=probe.state().position;
    const from=probe.events.length;
    probe.pointer('mousedown',r.x+r.width+.5,r.y+2.1,1);
    probe.pointer('mousemove',r.x+r.width+.5,r.y+r.height-.2,1);
    return {hit,editor:probe.editor.num,frame,afterFrame:probe.r.captureHitMap().frameId,events:probe.events.slice(from)};
  })()`);
  console.log("capture/release/press", JSON.stringify(result));
  expect(result).toMatchObject({ hit: await browser.evaluate("probe.editor.num") });
  expect(await browser.evaluate("probe.events.slice(-10).some(e=>e.type==='down')")).toBe(true);
  await wait("probe.state().position>window.before+1", "scrollbar drag after capture release");
  console.log("capture release press proof passed");
} finally {
  await server.stop(true);
}
