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
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

type SnapshotEntry = {
  path: string;
  kind: "file" | "directory";
  size: number;
  mtimeMs: number;
  content?: string;
};
/** What the in-browser Server finds around it (docs/WEB.md, `server-seed.json`). */
type Seed = { env?: Record<string, string>; files?: SnapshotEntry[] };

const root = resolve(import.meta.dirname, "../..");
const target = resolve(import.meta.dirname, "../public/demo");

/**
 * When the documents were last modified, as the capture dates them (scripts/capture.py,
 * DOCS_CLOCK): a checkout dates its files from the moment it was made.
 */
const DOCS_CLOCK = Date.parse("2026-09-23T09:00:00Z");

/** `directory` of the checkout under `mount`, only the files `keep` accepts, all modified at `clock`. */
async function snapshot(
  directory: string,
  mount: string,
  keep: (path: string) => boolean,
  clock: number,
) {
  const entries: SnapshotEntry[] = [];
  const base = join(root, directory);
  for (const name of await readdir(base, { recursive: true })) {
    const path = join(base, name);
    const info = await stat(path);
    if (info.isFile() && !keep(name)) continue;
    const at = `${mount}/${relative(base, path)}`;
    entries.push(
      info.isDirectory()
        ? { path: at, kind: "directory", size: 0, mtimeMs: clock }
        : {
            path: at,
            kind: "file",
            size: info.size,
            mtimeMs: clock,
            content: (await readFile(path)).toString("base64"),
          },
    );
  }
  return entries;
}

/** The applications whose Server can run in a page: where each is, what it finds around it. */
export const DEMOS: Record<string, { app: string; seed?: () => Promise<Seed> }> = {
  // The capture's clock (scripts/capture.py, FORGE_CLOCK): the same ages on both screens.
  forge: {
    app: "examples/forge",
    seed: async () => ({ env: { FORGE_CLOCK_START: "2026-09-23T09:00:00Z" } }),
  },
  notes: { app: "examples/notes" },
  // The repository's own documentation, as `MD_PATH=docs bun run mdreader` reads it.
  mdreader: {
    app: "examples/mdreader",
    seed: async () => ({
      env: { MD_PATH: "/docs" },
      files: await snapshot("docs", "/docs", (path) => path.endsWith(".md"), DOCS_CLOCK),
    }),
  },
  // No key can live in a static site: a scripted model answers, in the Server.
  chat: { app: "examples/chat", seed: async () => ({ env: { CHAT_DEMO: "1" } }) },
  // coder's scripted harness: no binary to start and no model to ask, in the Server. The
  // project path is the capture's (scripts/capture.py, CODER_CWD): the same header.
  coder: {
    app: "examples/coder",
    seed: async () => ({
      env: { CODER_HARNESS: "fake", CODER_CWD: "/home/ada/src/timers" },
    }),
  },
  // `airtty devtools --demo` with no bus: a page has no socket to listen on.
  devtools: {
    app: "packages/airtty/src/devtools/airtty-devtools",
    seed: async () => ({
      env: { AIRTTY_DEVTOOLS_LISTEN: "none", AIRTTY_DEVTOOLS_DEMO: "1" },
    }),
  },
};
/** The web runtime's files: the framework's, not an application's. */
const RUNTIME = ["runtime.js", "opentui.wasm", "xterm.css", "tree-sitter", "web-runtime.json"];

await rm(target, { recursive: true, force: true });
let runtime: string | undefined;
for (const [name, { app, seed: seedOf }] of Object.entries(DEMOS)) {
  // Node's API, not Bun's: website/ has no Bun types, and Bun runs it the same.
  const build = spawnSync(
    "bun",
    ["packages/airtty/src/cli.ts", "build", "--app", app, "--web-local"],
    { cwd: root, stdio: ["ignore", "inherit", "inherit"] },
  );
  if (build.status !== 0) process.exit(build.status ?? 1);
  const site = join(root, app, ".airtty/web");
  const abi = await readFile(join(site, "web-runtime.json"), "utf8");
  if (runtime === undefined) {
    runtime = abi;
    await mkdir(join(target, "runtime"), { recursive: true });
    for (const name of RUNTIME)
      await cp(join(site, name), join(target, "runtime", name), { recursive: true });
  } else if (abi !== runtime) {
    throw new Error(`${name} was built for another web runtime than the first demo`);
  }
  // Source maps weigh twice the rest and only serve DevTools: they stay out of the site.
  await cp(site, join(target, name), {
    recursive: true,
    filter: (path) => !path.endsWith(".map") && !RUNTIME.some((name) => path === join(site, name)),
  });
  const page = await readFile(join(site, "index.html"), "utf8");
  const shared = page
    .replace('href="xterm.css"', 'href="../runtime/xterm.css"')
    .replace('src="runtime.js"', 'src="../runtime/runtime.js"');
  if (!shared.includes("../runtime/runtime.js") || !shared.includes("../runtime/xterm.css"))
    throw new Error(`${site}/index.html no longer loads runtime.js and xterm.css by name`);
  await writeFile(join(target, name, "index.html"), shared);
  const seed = await seedOf?.();
  if (seed) await writeFile(join(target, name, "server-seed.json"), JSON.stringify(seed));
  console.log(`demo: ${join(target, name)}`);
}
