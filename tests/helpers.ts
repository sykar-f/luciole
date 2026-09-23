import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
export async function launch(file: string, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["--conditions=react-server", file], {
    env: { ...process.env, PORT: "0", AIRTTY_TEST: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (s) => (errors += s));
  const ready = await new Promise<any>((yes, no) => {
    const timer = setTimeout(() => {
      child.kill();
      no(new Error("startup timeout " + errors));
    }, 10000);
    child.on("exit", () => {
      clearTimeout(timer);
      no(new Error("server exited " + errors));
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const value = JSON.parse(line);
        if (value.ready) {
          clearTimeout(timer);
          yes(value);
        }
      } catch {}
    });
  });
  return {
    child,
    ...ready,
    url: `http://127.0.0.1:${ready.port}`,
    stop: () =>
      new Promise<void>((done) => {
        if (child.exitCode !== null || child.signalCode !== null) return done();
        child.once("exit", () => done());
        child.kill();
      }),
  };
}
export async function until(check: () => boolean, timeout = 5000) {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > timeout) throw new Error("Condition timed out");
    await Bun.sleep(10);
  }
}
/**
 * The Draft store of a generated Client (`components/draft.ts`): application state,
 * reached through the build's Client Reference registry like any "use client" module.
 */
export function draftsOf(app: any) {
  const { buildId, resolveModule } = app.options;
  return resolveModule(`${buildId}/components/draft.ts`).drafts;
}
