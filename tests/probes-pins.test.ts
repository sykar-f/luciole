import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const root = join(import.meta.dir, "..");
const catalog = z
  .object({ workspaces: z.object({ catalog: z.record(z.string(), z.string()) }) })
  .parse(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).workspaces.catalog;
const packages = ["@opentui/core", "@opentui/react", "@opentui/keymap"];
const manifest = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
});

for (const probe of readdirSync(join(root, "probes"), { withFileTypes: true })) {
  if (!probe.isDirectory()) continue;
  const path = join("probes", probe.name, "package.json");
  const pkg = manifest.parse(JSON.parse(readFileSync(join(root, path), "utf8")));
  for (const [section, pins] of Object.entries(pkg)) {
    for (const name of packages) {
      const version = pins?.[name];
      if (version === undefined) continue;
      test(`${path} ${section} ${name} matches the root catalog`, () => {
        expect(version).toBe(catalog[name]);
      });
    }
  }
}
