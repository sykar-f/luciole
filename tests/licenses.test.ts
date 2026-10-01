import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { classify, licenseOf } from "../scripts/licenses";
import { execute } from "./helpers";

const script = resolve("scripts/licenses.ts");
let work: string;

async function install(name: string, license: unknown, deps: Record<string, string> = {}) {
  const dir = join(work, "node_modules", name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name, version: "1.0.0", license, dependencies: deps }),
  );
}

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "licenses-"));
  await mkdir(join(work, "pkg"), { recursive: true });
  await writeFile(
    join(work, "pkg", "package.json"),
    JSON.stringify({ name: "shipped", dependencies: { fine: "1.0.0" } }),
  );
  await install("fine", "MIT", { deep: "1.0.0" });
  await install("deep", "MIT");
});
afterAll(() => rm(work, { recursive: true, force: true }));

const check = (...extra: string[]) =>
  execute(["bun", script, "--root", work, "--ship", "pkg", ...extra]);

test("a permissive tree exits 0", async () => {
  const run = await check();
  expect(run.exitCode).toBe(0);
  expect(run.stdout.toString()).toContain("OK: no blocking licence");
});

test("a GPL dependency deep in a shipped tree exits non-zero and is named", async () => {
  await install("deep", "GPL-3.0-only");
  const run = await check();
  expect(run.exitCode).toBe(1);
  expect(run.stdout.toString()).toContain("deep@1.0.0 GPL-3.0-only");
  await install("deep", "MIT");
});

test("a missing licence blocks too", async () => {
  await install("deep", undefined);
  expect((await check()).exitCode).toBe(1);
  await install("deep", "MIT");
});

test("a private workspace with a blocking licence is reported, not failed", async () => {
  await mkdir(join(work, "private"), { recursive: true });
  await writeFile(
    join(work, "private", "package.json"),
    JSON.stringify({ name: "private-app", dependencies: { gpl: "1.0.0" } }),
  );
  await install("gpl", "AGPL-3.0");
  const run = await check("--other", "private");
  expect(run.exitCode).toBe(0);
  expect(run.stdout.toString()).toMatch(/gpl@1.0.0 {2}AGPL-3.0 {2}blocking {2}via private-app/);
});

test("classify reads SPDX expressions", () => {
  expect(classify("MIT")).toBe("permissive");
  expect(classify("(MIT OR GPL-3.0)")).toBe("permissive");
  expect(classify("MIT AND GPL-3.0")).toBe("blocking");
  expect(classify("MPL-2.0")).toBe("notice");
  expect(classify("LGPL-3.0-or-later")).toBe("notice");
  expect(classify("SEE LICENSE IN README.md")).toBe("blocking");
  expect(classify("")).toBe("blocking");
  expect(licenseOf({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] })).toBe(
    "(MIT OR Apache-2.0)",
  );
});
