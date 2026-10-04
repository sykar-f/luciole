import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Capabilities } from "../packages/core/src/capabilities";

const root = join(import.meta.dir, "..");
const page = readFileSync(join(root, "website/src/content/docs/guides/untrusted-apps.mdx"), "utf8");
const grants = readFileSync(join(root, "packages/core/src/sandbox/grants.ts"), "utf8");

/** Every leaf of the schema, written as a reader writes it: `fs.read`, `openUrl`. */
const leaves = (value: unknown, prefix = ""): string[] =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value).flatMap(([key, child]) => leaves(child, `${prefix}${key}.`))
    : [prefix.slice(0, -1)];
/** The rows of the table under `## Declare and grant capabilities`: key and flag cells. */
/** The rows of the table that follows the `## Declare and grant capabilities` heading: key and flag cells. */
function capabilityRows() {
  const section =
    page.split(/^## /m).find((part) => part.startsWith("Declare and grant capabilities\n")) ?? "";
  return section
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => {
      const [key = "", flag = ""] = line
        .split("|")
        .slice(1)
        .map((cell) => cell.trim());
      return { key: key.replaceAll("`", ""), flag: /--allow-[a-z-]+/.exec(flag)?.[0] };
    });
}

test("the page lists every key of the Capabilities schema, and no other", () => {
  const keys = leaves(Capabilities.parse({}));
  expect(keys.length).toBeGreaterThan(0);
  expect(new Set(capabilityRows().map((row) => row.key))).toEqual(new Set(keys));
});

test("the page lists every --allow-* flag of grants.ts, and no other", () => {
  const flags = [...grants.matchAll(/^\s+"(--allow-[a-z-]+)":/gm)].map((match) => match[1]);
  expect(flags.length).toBeGreaterThan(0);
  expect(new Set(capabilityRows().map((row) => row.flag))).toEqual(new Set(flags));
});
