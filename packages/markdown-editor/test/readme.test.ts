/**
 * The README's program is the one in `example/`, which `bun run check` type-checks and the
 * website's capture runs: the page npm shows cannot drift from the code it claims works.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

test("the README's tsx block is example/index.tsx", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const blocks = [...readme.matchAll(/```tsx\n([\s\S]*?)```/g)];
  expect(blocks).toHaveLength(1);
  expect(blocks[0]?.[1]).toBe(readFileSync(join(root, "example/index.tsx"), "utf8"));
});
