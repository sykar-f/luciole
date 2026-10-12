import { appendFileSync } from "node:fs";

/** Private test diagnostics: independent of the stdout pipe that carries readiness. */
export function startupStage(stage: string) {
  const file = process.env["LUCIOLE_TEST_STARTUP_TRACE"];
  if (process.env["LUCIOLE_TEST"] !== "1" || !file) return;
  try {
    appendFileSync(file, JSON.stringify({ stage, at: Date.now(), cpu: process.cpuUsage() }) + "\n");
  } catch {
    // Diagnostics must not change startup if the parent has already removed its trace.
  }
}

startupStage("core-module-load");
