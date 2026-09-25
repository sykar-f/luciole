/**
 * Reads the screen box.ts draws on a real terminal emulator (scripts/pty/driver.ts):
 *   OPENTUI_SRC=… OPENTUI_WASM_PATH=…/opentui.wasm bun probes/web/opentui-wasm/check-box.ts
 */
import { join } from "node:path";
import { drive } from "../../../scripts/pty/driver";

const out = join(import.meta.dir, ".airtty/box");
const build = Bun.spawnSync(
  [
    process.execPath,
    join(import.meta.dir, "build.ts"),
    join(import.meta.dir, "src/box.ts"),
    out,
    "bun",
  ],
  {
    stdio: ["ignore", "ignore", "inherit"],
  },
);
if (build.exitCode !== 0) process.exit(1);
await using driver = await drive({
  command: [process.execPath, join(out, "box.js")],
  cols: 50,
  rows: 8,
  env: { PROBE_HOLD: "1" },
});
await driver.waitFor("Hello from opentui.wasm");
console.log((await driver.lines()).join("\n"));
await driver.type("q\r");
await driver.exited();
