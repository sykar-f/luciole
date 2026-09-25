/**
 * Types into form.tsx on a real terminal emulator and reads what it draws:
 *   OPENTUI_SRC=… OPENTUI_WASM_PATH=…/opentui.wasm bun probes/web/opentui-wasm/check-form.ts
 */
import { join } from "node:path";
import { drive, Keys } from "../../../scripts/pty/driver";

// NATIVE=1: the same source on the published native OpenTUI, to compare behaviors.
const native = process.env.NATIVE === "1";
const out = join(import.meta.dir, ".airtty/form");
const source = join(import.meta.dir, "src/form.tsx");
if (!native) {
  const build = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "build.ts"), source, out, "bun"],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  if (build.exitCode !== 0) process.exit(1);
}
await using driver = await drive({
  command: [process.execPath, native ? source : join(out, "form.js")],
  cols: 60,
  rows: 14,
});
await driver.waitFor("Type a note");
await driver.type("héllo wasm");
await driver.waitFor("héllo wasm");
await driver.type(Keys.enter);
await driver.waitFor("1. héllo wasm");
await driver.type("日本語 second");
await driver.type(Keys.enter);
await driver.waitFor("2. 日本語 second");
await driver.waitFor("2 note(s)");
console.log((await driver.lines()).join("\n"));
await driver.type(Keys.escape);
await driver.exited();
