/** Ordinary editor hits through the same WASM and xterm path as the web runtime. */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { defaultCache } from "../../packages/core/src/compile";
import { webRuntimeDirectory } from "../../packages/core/src/web-runtime";
import { opentuiWasm } from "../../packages/core/src/web/opentui/plugin";
import { browserNode } from "../../packages/core/src/web/node/plugin";
import { Browser } from "./cdp";

const TIMEOUT_MS = 240_000;
const HASH_LENGTH = 16;
const LAST_ROW = 4;
const FIRST_OFFSET = 3;
test(
  "web last-row editor presses use screen and document coordinates",
  async () => {
    // Preparation runs off the test worker so the watchdog can still observe it.
    const prepared = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import {prepareWebRuntime} from ${JSON.stringify(join(import.meta.dir, "../../packages/core/src/web-runtime.ts"))}; await prepareWebRuntime();`,
      ],
      { stdout: "inherit", stderr: "inherit" },
    );
    expect(await prepared.exited).toBe(0);
    const runtime = await webRuntimeDirectory();
    const patch = await Bun.file(
      join(import.meta.dir, "../../packages/core/web/opentui-v0.6.6.patch"),
    ).arrayBuffer();
    const key = createHash("sha256")
      .update(new Uint8Array(patch))
      .digest("hex")
      .slice(0, HASH_LENGTH);
    const checkout = join(defaultCache(), "web", `opentui-v0.6.6-${key}`);
    const bundled = await Bun.build({
      entrypoints: [join(import.meta.dir, "editor-hits-page.ts")],
      target: "browser",
      format: "esm",
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      plugins: [
        opentuiWasm,
        {
          name: "editor-hits-sources",
          setup(build) {
            build.onResolve({ filter: /^@opentui\/core$/ }, () => ({
              path: join(checkout, "packages/core/src/index.ts"),
            }));
          },
        },
        browserNode,
      ],
    });
    if (!bundled.success) throw new Error(bundled.logs.map(String).join("\n"));
    const script = await bundled.outputs[0]?.text();
    const css = await Bun.file(join(runtime, "xterm.css")).text();
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/page.js")
          return new Response(script, { headers: { "content-type": "text/javascript" } });
        if (path === "/opentui.wasm") return new Response(Bun.file(join(runtime, "opentui.wasm")));
        return new Response(
          `<style>${css}body{margin:0}</style><script type="module" src="/page.js"></script>`,
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    try {
      await using browser = await Browser.start();
      await browser.open(server.url.href);
      await browser.waitFor(
        "!!globalThis.editorHits?.lines().some(line => line.includes('line 2'))",
        "the editor's last row",
      );
      for (const top of [0, LAST_ROW])
        for (const scroll of [0, 2]) {
          const block = 2 + scroll / 2;
          await browser.evaluate(`editorHits.at(${top}, ${scroll})`);
          await browser.waitFor(
            `editorHits.lines()[${top + LAST_ROW}]?.slice(2,8)==='line ${block}'`,
            "the last visible document row",
          );
          await browser.clickAt(`editorHits.point(${top}, ${scroll})`);
          await browser.waitFor(
            `editorHits.selection().block===${block} && editorHits.selection().offset===${FIRST_OFFSET + scroll / 2}`,
            "the last-row press at the document position",
          );
        }
    } finally {
      await server.stop(true);
    }
  },
  TIMEOUT_MS,
);
