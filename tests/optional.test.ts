import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  assertInstalled,
  GRAMMAR_PACKAGES,
  loadOptional,
  WEB_RUNTIME_PACKAGES,
  WEB_SERVER_PACKAGES,
} from "../packages/luciole/src/optional";

const source = join(import.meta.dir, "../packages/luciole/src");

describe("optional dependencies", () => {
  test("a missing package is reported with the command that installs it", async () => {
    const missing = "luciole-test-not-installed";
    const error = await loadOptional("luciole/math", missing, () =>
      import(missing).then((module: unknown) => module),
    ).catch((thrown: unknown) => thrown);
    if (!(error instanceof Error)) throw new Error("loadOptional did not throw");
    expect(error.message).toContain(`luciole/math needs the optional package ${missing}`);
    expect(error.message).toContain(`bun add ${missing}`);
  });

  test("another failure is not taken for a missing package", async () => {
    const failure = new Error("boom");
    const error = await loadOptional("luciole/math", "zod", () => Promise.reject(failure)).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBe(failure);
  });

  test("the packages the features name are installed in the workspace", () => {
    for (const names of [GRAMMAR_PACKAGES, WEB_RUNTIME_PACKAGES, WEB_SERVER_PACKAGES])
      expect(() => assertInstalled("a feature", names)).not.toThrow();
  });
});

// A copy of the modules with no `node_modules` above it (and no auto-install): what an app that
// did not install the optional packages sees.
describe("an app without the optional packages", () => {
  let root = "";
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "luciole-optional-"));
    await cp(join(source, "optional.ts"), join(root, "optional.ts"));
    await cp(join(source, "math.ts"), join(root, "math.ts"));
    await writeFile(
      join(root, "check.ts"),
      `import { assertInstalled, GRAMMAR_PACKAGES, WEB_RUNTIME_PACKAGES, WEB_SERVER_PACKAGES } from "./optional";
const lists = { grammars: GRAMMAR_PACKAGES, runtime: WEB_RUNTIME_PACKAGES, server: WEB_SERVER_PACKAGES };
const message = (names: readonly string[]) => {
  try { assertInstalled("feature", names); return "none"; } catch (error) { return String(error instanceof Error ? error.message : error); }
};
console.log(JSON.stringify(Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, message(v)]))));
`,
    );
    await writeFile(
      join(root, "math-run.ts"),
      `import { renderMath } from "./math";
await renderMath("x", { display: false, color: "#000", scale: 4 }).catch((error: unknown) => {
  console.log(error instanceof Error ? error.message : String(error));
});
`,
    );
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  async function run(file: string) {
    const child = Bun.spawn([process.execPath, "--no-install", join(root, file)], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { stdout, code };
  }

  test("importing luciole/math is fine until a formula is drawn, then names the package", async () => {
    const { stdout, code } = await run("math-run.ts");
    expect(code).toBe(0);
    expect(stdout).toContain("luciole/math needs the optional package @resvg/resvg-wasm");
    expect(stdout).toContain("bun add @resvg/resvg-wasm");
  });

  test("the grammar and web build guards name the first package missing", async () => {
    const { stdout, code } = await run("check.ts");
    expect(code).toBe(0);
    const messages = z.record(z.string(), z.string()).parse(JSON.parse(stdout));
    expect(messages["grammars"]).toContain("needs the optional package tree-sitter-bash");
    expect(messages["runtime"]).toContain("bun add @xterm/xterm");
    expect(messages["server"]).toContain("bun add @sqlite.org/sqlite-wasm");
  });
});
