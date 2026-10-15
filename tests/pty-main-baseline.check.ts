/** Diagnostic comparison requested by the PTY rework; removed after attribution. */
import { expect, test } from "bun:test";
import { execute } from "./helpers";

test("main baseline: mdreader selection", async () => {
  const cwd = process.env.LUCIOLE_PTY_BASELINE_PATH;
  if (!cwd) throw new Error("LUCIOLE_PTY_BASELINE_PATH must name the detached main checkout");
  const result = await execute([process.execPath, "scripts/pty/mdreader.ts"], { cwd });
  console.log(result.stdout.toString());
  console.error(result.stderr.toString());
  expect(result.exitCode).toBe(0);
}, 240_000);
