import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { z } from "zod";

// The root lint ignores website/, which is linted from there with its own config: oxlint's
// `extends` drops the options of the rules it inherits (and the categories), so that file
// is a full copy of the root's. These tests keep the copy honest: both resolved configs must
// say the same about every rule. They need only the root's oxlint binary, not website/'s install.
const root = resolve(import.meta.dir, "..");

// Everything oxlint prints is kept (loose objects), so an option nobody thought of yet is
// compared too. Only what legitimately differs between the two files is set aside.
const Resolved = z.looseObject({
  options: z.looseObject({ typeAware: z.boolean().optional() }),
  rules: z.record(z.string(), z.unknown()),
  // Absent from the print when a config has none.
  overrides: z
    .array(z.looseObject({ files: z.array(z.string()), rules: z.record(z.string(), z.unknown()) }))
    .default([]),
  ignorePatterns: z.array(z.string()),
});

const DIFFERS_BY_DESIGN = new Set(["$schema", "overrides", "ignorePatterns"]);

function comparable(config: z.infer<typeof Resolved>) {
  return Object.fromEntries(Object.entries(config).filter(([key]) => !DIFFERS_BY_DESIGN.has(key)));
}

async function resolved(cwd: string, config: string) {
  const child = Bun.spawn(
    [resolve(root, "node_modules/.bin/oxlint"), "-c", config, "--print-config"],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`oxlint --print-config ${config} failed: ${err}`);
  return Resolved.parse(JSON.parse(out));
}

test("website/ is linted by exactly the root's rules, options included", async () => {
  const [base, site] = await Promise.all([
    resolved(root, ".oxlintrc.json"),
    resolved(resolve(root, "website"), "oxlint.website.json"),
  ]);
  expect(Object.keys(base.rules).length).toBeGreaterThan(0);
  expect(comparable(site)).toEqual(comparable(base));
});

test("the website is linted type-aware, with the type-aware rules on", async () => {
  const site = await resolved(resolve(root, "website"), "oxlint.website.json");
  expect(site.options.typeAware).toBe(true);
  for (const rule of ["no-unsafe-assignment", "no-unsafe-call", "no-unsafe-member-access"])
    expect(site.rules[`typescript/${rule}`]).toBeDefined();
});

test("the root config ignores website/, and no website file is exempt from a rule", async () => {
  const [base, site] = await Promise.all([
    resolved(root, ".oxlintrc.json"),
    resolved(resolve(root, "website"), "oxlint.website.json"),
  ]);
  expect(base.ignorePatterns).toContain("website/**");
  expect(base.overrides.flatMap((o) => o.files).some((f) => f.startsWith("website/"))).toBe(false);
  expect(site.overrides).toEqual([]);
});
