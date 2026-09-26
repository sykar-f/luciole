/**
 * Builds the landing page's live demos: example applications as static sites whose Server
 * runs in the browser (docs/WEB.md, `airtty build --web-local`), in public/demo/<app>/.
 * The web runtime is the framework's, the same for every application: it is published once
 * in public/demo/runtime/ and each demo's page loads it from there, so the first demo a
 * reader starts puts the others' largest files in the browser's cache. Generated, not
 * committed: rerun after a change to the framework or to an example.
 *   bun run demo          # from website/
 */
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** The examples whose Server can run in a page. */
export const DEMOS = ["forge", "notes"] as const;
/** The web runtime's files: the framework's, not an application's. */
const RUNTIME = ["runtime.js", "opentui.wasm", "xterm.css", "tree-sitter", "web-runtime.json"];

const root = resolve(import.meta.dirname, "../..");
const target = resolve(import.meta.dirname, "../public/demo");

await rm(target, { recursive: true, force: true });
let runtime: string | undefined;
for (const app of DEMOS) {
  // Node's API, not Bun's: website/ has no Bun types, and Bun runs it the same.
  const build = spawnSync(
    "bun",
    ["packages/airtty/src/cli.ts", "build", "--app", `examples/${app}`, "--web-local"],
    { cwd: root, stdio: ["ignore", "inherit", "inherit"] },
  );
  if (build.status !== 0) process.exit(build.status ?? 1);
  const site = join(root, "examples", app, ".airtty/web");
  const abi = await readFile(join(site, "web-runtime.json"), "utf8");
  if (runtime === undefined) {
    runtime = abi;
    await mkdir(join(target, "runtime"), { recursive: true });
    for (const name of RUNTIME)
      await cp(join(site, name), join(target, "runtime", name), { recursive: true });
  } else if (abi !== runtime) {
    throw new Error(`${app} was built for another web runtime than ${DEMOS[0]}`);
  }
  // Source maps weigh twice the rest and only serve DevTools: they stay out of the site.
  await cp(site, join(target, app), {
    recursive: true,
    filter: (path) => !path.endsWith(".map") && !RUNTIME.some((name) => path === join(site, name)),
  });
  const page = await readFile(join(site, "index.html"), "utf8");
  const shared = page
    .replace('href="xterm.css"', 'href="../runtime/xterm.css"')
    .replace('src="runtime.js"', 'src="../runtime/runtime.js"');
  if (!shared.includes("../runtime/runtime.js") || !shared.includes("../runtime/xterm.css"))
    throw new Error(`${site}/index.html no longer loads runtime.js and xterm.css by name`);
  await writeFile(join(target, app, "index.html"), shared);
  console.log(`demo: ${join(target, app)}`);
}
