/* eslint-disable no-magic-numbers -- Synthetic pixel fixture geometry and colors. */
/** Browser proof of the host contract using only synthetic ANSI and DOM input. */
import { expect } from "bun:test";
import * as z from "zod/mini";
import { Browser } from "./cdp";

const Report = z.object({
  op: z.string(),
  generation: z.optional(z.number()),
  modifiers: z.optional(z.number()),
  dy: z.optional(z.number()),
  action: z.optional(z.string()),
});
const InputProof = z.object({
  reports: z.array(Report),
  heldReports: z.array(Report),
  nativeModifier: z.number(),
});

const bundle = await Bun.build({
  entrypoints: [import.meta.dir + "/pixel-scroll-page.ts"],
  target: "browser",
});
if (!bundle.success) throw new Error(bundle.logs.map((log) => log.message).join("\n"));
const script = await bundle.outputs[0]?.text();
const css = await Bun.file(
  import.meta.dir + "/../../node_modules/@xterm/xterm/css/xterm.css",
).text();

async function verify(dpr: number) {
  const site = Bun.serve({
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      return path === "/fixture.js"
        ? new Response(script, { headers: { "content-type": "text/javascript" } })
        : new Response(
            `<style>${css} body{margin:0}</style><script type="module" src="/fixture.js"></script>`,
            { headers: { "content-type": "text/html" } },
          );
    },
  });
  try {
    await using browser = await Browser.start({ deviceScaleFactor: dpr });
    await browser.send("Emulation.setDeviceMetricsOverride", {
      width: 800,
      height: 600,
      // Preserve the native scale so ResizeObserver measures physical pixels.
      deviceScaleFactor: 0,
      mobile: false,
    });
    await browser.open(site.url.href);
    await browser.waitFor("!!window.probe", "the synthetic host fixture");
    await browser.evaluate(
      `probe.write('\\x1b[?1049h'+probe.sync(probe.paint(0) + probe.op({op:'query',version:1,nonce:'browser'})) + probe.mode)`,
    );
    expect(await browser.evaluate(`probe.reports[0]`)).toMatchObject({
      op: "capability",
      reason: "ready",
      snapshot: true,
      precise: true,
    });
    expect(
      await browser.evaluate(`(() => {
        const canvas = document.querySelector('.xterm-webgl-layer');
        return { dpr: devicePixelRatio, width: canvas.width, height: canvas.height };
      })()`),
    ).toEqual(
      await browser.evaluate(`(() => {
        const rect = document.querySelector('.xterm-webgl-layer').getBoundingClientRect();
        const dpr = ${dpr};
        return { dpr, width: rect.width * dpr, height: rect.height * dpr };
      })()`),
    );
    // Every onRender framebuffer is checked, not just the eventual screenshot.
    // Band colors identify every physical content row; chrome stays pixel-identical.
    const proof = await browser.evaluate(`(async () => {
      const {width,height,cellHeight:H,cellWidth:W} = probe.dimensions();
      const r = probe.rect;
      const errors = [];
      let checked = 0, generation = 0;
      const inspect = (origin, fraction, expectedGeneration) => {
        const q = Math.floor(fraction * H + 0.5);
        for (const frame of probe.frames.splice(0)) {
          if (frame.generation !== expectedGeneration) { errors.push('generation:'+frame.generation+'/'+expectedGeneration); continue; }
          for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
            const inside = x>=r.x*W && x<(r.x+r.width)*W && y>=r.y*H && y<(r.y+r.height)*H;
            const local = y-r.y*H+q;
            const rgb = inside ? probe.color(origin + Math.floor(local/H) + (local%H < H/2 ? 0 : 16)) : [17,34,51];
            const at = ((height-1-y)*width+x)*4;
            if(rgb.some((v,i)=>frame.data[at+i]!==v)) {
              errors.push('pixel:'+expectedGeneration+':'+x+','+y+':'+frame.data.slice(at,at+3)+'/'+rgb);
              return;
            }
          }
          checked++;
        }
      };
      probe.frames.length=0;
      for (const position of [0, .001, .12, .49, .88, .999, 1.01, 1.45, 1.99, 2.01, 2.5, 3.1]) {
        const origin=Math.floor(position), fraction=position-origin;
        await probe.write(probe.sync(probe.transaction(++generation,origin,fraction)));
        inspect(origin,fraction,generation);
        probe.redraw();
        await probe.write('');
        inspect(origin,fraction,generation);
      }
      // A moved/chrome-changing half-frame stays invisible, including an expired
      // synchronized-output envelope and a cursor/partial refresh.
      const active = generation;
      await probe.write('\\x1b[?2026h'+probe.op({op:'begin',version:1,generation:++generation})+probe.paint(7,true)+
        probe.op({op:'register',version:1,generation,id:1,rect:{x:1,y:1,width:5,height:3},origin:7}));
      probe.redraw();
      await new Promise(resolve=>setTimeout(resolve,1100));
      await probe.write('');
      inspect(3,.1,active);
      // Stale step and rejected commit retain the entire old frame.
      await probe.write(probe.op({op:'step',version:1,generation:active,id:1,fraction:.7})+
        probe.op({op:'commit',version:1,generation})+'\\x1b[?2026l');
      inspect(3,.1,active);
      // A valid ready frame survives a later begin before the render.
      const ready=++generation;
      await probe.write(probe.sync(probe.transaction(ready,4,.25)+
        probe.op({op:'begin',version:1,generation:++generation})+probe.paint(9,true)));
      inspect(4,.25,ready);
      // A fractional release, even at a rounded-zero offset, is rejected.
      const zero=++generation;
      await probe.write(probe.sync(probe.transaction(zero,5,.001)+probe.op({op:'release',version:1,id:1,generation:zero})));
      inspect(5,.001,zero);
      // Canonical release with intervening painting is refused.
      const dirty=++generation;
      await probe.write(probe.sync(probe.transaction(dirty,6,0)+probe.paint(7,true)+probe.op({op:'release',version:1,id:1,generation:dirty})));
      inspect(6,0,dirty);
      const canonical=++generation;
      await probe.write(probe.sync(probe.transaction(canonical,8,0)+probe.op({op:'release',version:1,id:1,generation:canonical})));
      inspect(8,0,0);
      // Release is accepted before ordinary output advances the canonical grid,
      // all in one parser task before the next presentation.
      const advanced=++generation;
      await probe.write(probe.sync(probe.transaction(advanced,9,0)+
        probe.op({op:'release',version:1,id:1,generation:advanced})+probe.paint(10)));
      if (!probe.frames.length) errors.push('advanced release did not render');
      inspect(10,0,0);
      if (probe.pixels.present()) errors.push('advanced release retained a frame');
      probe.redraw(); await probe.write('');
      inspect(10,0,0);
      // A new incomplete transaction after an accepted release must still hold
      // the prior image, including on a later ordinary redraw.
      const held=++generation, incomplete=++generation;
      await probe.write(probe.sync(probe.transaction(held,11,0)+
        probe.op({op:'release',version:1,id:1,generation:held})+
        probe.transaction(incomplete,12,.25,false)));
      if (!probe.frames.length) errors.push('incomplete transaction did not render');
      inspect(11,0,held);
      probe.redraw(); await probe.write('');
      inspect(11,0,held);
      await probe.write(probe.sync(probe.op({op:'commit',version:1,generation:incomplete})));
      inspect(12,.25,incomplete);
      return {errors,checked,glError:probe.glError(),H,W};
    })()`);
    expect(proof).toMatchObject({ errors: [], glError: 0 });
    expect(z.object({ checked: z.number() }).parse(proof).checked).toBeGreaterThanOrEqual(29);
    const cursor = await browser.evaluate(`(async () => {
      probe.terminal.focus();
      await probe.write(probe.sync(probe.transaction(50,1,.25,false)+'\\x1b[?25h\\x1b[2;11H'+
        probe.op({op:'commit',version:1,generation:50})));
      probe.frames.length=0;
      probe.redraw(); await probe.write('');
      const {width,height,cellHeight:H,cellWidth:W}=probe.dimensions();
      const frame=probe.frames.at(-1);
      let cursorPixels=0;
      for(let y=H;y<2*H;y++) for(let x=10*W;x<11*W;x++) {
        const at=((height-1-y)*width+x)*4;
        if([17,34,51].some((v,i)=>frame.data[at+i]!==v)) cursorPixels++;
      }
      return cursorPixels;
    })()`);
    expect(z.number().parse(cursor)).toBeGreaterThan(0);
    const input = await browser.evaluate(`(async () => {
        await probe.write(probe.sync(probe.transaction(100,2,.3)));
        await probe.write(probe.sync(probe.op({op:'begin',version:1,generation:101})));
        probe.reports.length=0;
        const target=document.querySelector('.xterm-screen');
        const point=probe.point();
        const wheel=(dx,dy,mode=0)=>target.dispatchEvent(new WheelEvent('wheel',{
          ...point,bubbles:true,cancelable:true,deltaX:dx,deltaY:dy,deltaMode:mode,ctrlKey:true}));
        const consumed = [wheel(4,5),wheel(0,70000,1)];
        for(const [type,buttons] of [['mousemove',0],['mousedown',1],['mousemove',1],['mouseup',0]]) {
          target.dispatchEvent(new MouseEvent(type,{...point,bubbles:true,cancelable:true,button:0,buttons}));
        }
        const reports=probe.reports.splice(0);
        // xterm's native selection is held until the canonical release is rendered.
        const isMac=['Macintosh','MacIntel','MacPPC','Mac68K'].includes(navigator.platform);
        probe.terminal.options.macOptionClickForcesSelection=true;
        const nativeKeys=isMac?{altKey:true}:{shiftKey:true};
        const nativeModifier=isMac?2:1;
        const end={...point,clientX:point.clientX+2*probe.dimensions().cellWidth};
        let native=0;
        target.addEventListener('mousedown',()=>native++);
        target.dispatchEvent(new MouseEvent('mousedown',{...point,bubbles:true,cancelable:true,button:0,buttons:1,detail:1,...nativeKeys}));
        target.dispatchEvent(new MouseEvent('mousemove',{...end,bubbles:true,cancelable:true,button:0,buttons:1,...nativeKeys}));
        target.dispatchEvent(new MouseEvent('mouseup',{...end,bubbles:true,cancelable:true,button:0,buttons:0,...nativeKeys}));
        const before=native;
        const heldReports=probe.reports.splice(0);
        await probe.write(probe.sync(probe.transaction(102,2,0)+probe.op({op:'release',version:1,id:1,generation:102})));
        const after=native;
        // Reduced motion revokes the nonce, then a fresh query can discover again.
        return {reports,heldReports,before,after,consumed,nativeModifier,selected:probe.terminal.hasSelection()};
      })()`);
    expect(input).toMatchObject({ before: 0, after: 1, consumed: [false, false], selected: true });
    const parsed = InputProof.parse(input);
    const wheel = parsed.reports.filter((report) => report.op === "wheel");
    expect(wheel).toHaveLength(3);
    expect(wheel.every((report) => report.generation === 100 && report.modifiers === 4)).toBe(true);
    expect(wheel.slice(1).reduce((total, report) => total + (report.dy ?? 0), 0)).toBe(70000);
    expect(
      parsed.reports.filter((report) => report.op === "pointer").map((report) => report.action),
    ).toEqual(["move", "down", "drag", "up"]);
    expect(parsed.heldReports).toHaveLength(1);
    expect(parsed.heldReports[0]).toMatchObject({
      op: "pointer",
      generation: 100,
      modifiers: parsed.nativeModifier,
      action: "down",
    });
    await browser.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await browser.waitFor(
      `probe.reports.some(r=>r?.reason==='reduced-motion')`,
      "reduced-motion revocation",
    );
    await browser.evaluate(
      `probe.write(probe.sync(probe.op({op:'query',version:1,nonce:'motion'})))`,
    );
    expect(await browser.evaluate(`probe.reports.at(-1)`)).toMatchObject({
      reason: "reduced-motion",
      snapshot: false,
    });
    await browser.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
    });
    await browser.evaluate(`probe.terminal.options.screenReaderMode=true`);
    await browser.evaluate(
      `probe.write(probe.sync(probe.op({op:'query',version:1,nonce:'reader'})))`,
    );
    expect(await browser.evaluate(`probe.reports.at(-1)`)).toMatchObject({
      reason: "screen-reader",
      precise: false,
    });
    await browser.evaluate(`probe.terminal.options.screenReaderMode=false`);
    await browser.evaluate(
      `document.querySelector('.xterm-webgl-layer').dispatchEvent(new Event('webglcontextlost',{cancelable:true}))`,
    );
    await browser.evaluate(
      `probe.write(probe.sync(probe.op({op:'query',version:1,nonce:'lost'})))`,
    );
    expect(await browser.evaluate(`probe.reports.at(-1)`)).toMatchObject({
      reason: "no-gpu",
      snapshot: false,
    });
  } finally {
    await site.stop(true);
  }
}

await verify(Number(process.argv[2] ?? 1));
