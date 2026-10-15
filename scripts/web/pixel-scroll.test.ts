/* eslint-disable no-magic-numbers -- Synthetic pixel fixture geometry and colors. */
/** Browser proof of the host contract using only synthetic ANSI and DOM input. */
import { expect, test } from "bun:test";
import { Browser } from "./cdp";

const bundle = await Bun.build({
  entrypoints: [import.meta.dir + "/pixel-scroll-page.ts"],
  target: "browser",
});
if (!bundle.success) throw new Error(bundle.logs.map((log) => log.message).join("\n"));
const script = await bundle.outputs[0]?.text();
const css = await Bun.file(
  import.meta.dir + "/../../node_modules/@xterm/xterm/css/xterm.css",
).text();

for (const dpr of [1, 2])
  test(`pixel host presents atomic, clipped GPU frames at DPR ${dpr}`, async () => {
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
      await using browser = await Browser.start();
      await browser.send("Emulation.setDeviceMetricsOverride", {
        width: 800,
        height: 600,
        deviceScaleFactor: dpr,
        mobile: false,
      });
      await browser.open(site.url.href);
      await browser.waitFor("!!window.probe", "the synthetic host fixture");
      await browser.evaluate(
        `probe.write(probe.sync(probe.paint(0) + probe.op({op:'query',version:1,nonce:'browser'})) + probe.mode)`,
      );
      expect(await browser.evaluate(`probe.reports[0]`)).toMatchObject({
        op: "capability",
        reason: "ready",
        snapshot: true,
        precise: true,
      });
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
            const rgb = inside ? probe.color(origin + Math.floor((y-r.y*H+q)/H)) : [17,34,51];
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
      return {errors,checked,glError:probe.glError(),H,W};
    })()`);
      expect(proof).toMatchObject({ errors: [], glError: 0 });
      expect(proof).toHaveProperty("checked");
    } finally {
      await site.stop(true);
    }
  }, 20_000);
