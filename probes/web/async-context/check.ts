/**
 * R2 (docs/WEB.md): the same 50 interleaved requests on Bun's own AsyncLocalStorage, on
 * this probe's without the transform (the control: it must fail), with it under Bun, and
 * with it in a Chrome Worker.
 *   bun probes/web/async-context/check.ts
 */
import { join } from "node:path";
import * as z from "zod/mini";
import { Browser } from "../../../scripts/web/cdp";
import { asyncContext } from "./plugin";

const here = import.meta.dir;
const out = join(here, ".airtty");
const entry = join(here, "src/entry.ts");
const EXAMPLES = 3;
const Result = z.object({ requests: z.number(), mismatches: z.array(z.string()) });
type Result = z.infer<typeof Result>;

async function bundle(name: string, transform: boolean, file = entry) {
  const result = await Bun.build({
    entrypoints: [file],
    outdir: join(out, name),
    target: "browser",
    plugins: [asyncContext({ transform })],
  });
  if (!result.success) throw new AggregateError(result.logs, `build ${name} failed`);
  return join(out, name, file === entry ? "entry.js" : "worker.js");
}
async function underBun(file: string): Promise<Result> {
  const run = Bun.spawnSync([process.execPath, file], { stderr: "inherit" });
  return Result.parse(JSON.parse(run.stdout.toString()));
}
const report = (name: string, { requests, mismatches }: Result) =>
  console.log(
    `${name}: ${requests} requests, ${mismatches.length} mismatches${mismatches.length ? `\n  e.g. ${mismatches.slice(0, EXAMPLES).join("\n  e.g. ")}` : ""}`,
  );

report("Bun AsyncLocalStorage (reference)", await underBun(entry));
report("probe, no transform (control)", await underBun(await bundle("control", false)));
const transformed = await bundle("transformed", true);
await bundle("transformed", true, join(here, "src/worker.ts"));
const bun = await underBun(transformed);
report("probe, transformed, Bun", bun);

const server = Bun.serve({
  port: 0,
  fetch: async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/")
      return new Response("<!doctype html><title>R2</title>", {
        headers: { "content-type": "text/html" },
      });
    const file = Bun.file(join(out, "transformed", path.slice(1)));
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    return new Response(file, { headers: { "content-type": "text/javascript" } });
  },
});
try {
  await using browser = await Browser.start();
  await browser.open(server.url.href);
  await browser.waitFor("document.readyState === 'complete'", "the page");
  const worker = Result.parse(
    await browser.evaluate(`new Promise((resolve, reject) => {
    const w = new Worker("/worker.js", { type: "module" });
    w.onmessage = (e) => resolve(e.data);
    w.onerror = (e) => reject(new Error(e.message));
  })`),
  );
  report("probe, transformed, Chrome Worker", worker);
  if (bun.mismatches.length || worker.mismatches.length) process.exitCode = 1;
} finally {
  await server.stop(true);
}
