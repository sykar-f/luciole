import { expect, test } from "bun:test";
import { z } from "zod";
import { PRIMITIVE_NODES } from "../packages/airtty/src/devtools/fibers";

const Output = z.object({
  owner: z.enum(["airtty", "react-devtools"]),
  renderers: z.number(),
  commits: z.array(z.array(z.object({ name: z.string(), unnecessary: z.boolean() }))),
  tree: z.array(
    z.object({
      name: z.string(),
      kind: z.string(),
      depth: z.number(),
      renders: z.number(),
      reason: z.string().optional(),
      unnecessary: z.boolean().optional(),
      hooks: z.array(z.string()).optional(),
      rect: z
        .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
        .optional(),
      env: z.string().optional(),
    }),
  ),
});
// The fixture runs in its own process, with the hook preloaded as docs/DEVTOOLS.md says.
async function spawnFixture(fixture: string, env: Record<string, string> = {}) {
  const child = Bun.spawn(
    [process.execPath, "--preload", "./packages/airtty/src/devtools/hook.ts", fixture],
    {
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;
  const line = stdout.trim().split("\n").at(-1) ?? "";
  try {
    const value: unknown = JSON.parse(line);
    return value;
  } catch {
    throw new Error(`fixture failed: ${stdout}\n${stderr}`);
  }
}
const run = async (env: Record<string, string> = {}) =>
  Output.parse(await spawnFixture("tests/devtools-fibers-fixture.tsx", env));
const byName = (output: z.infer<typeof Output>, name: string) =>
  output.tree.find((node) => node.name === name);

test("the preloaded hook counts renders, their reasons and the unnecessary ones", async () => {
  const output = await run();
  expect(output.owner).toBe("airtty");
  // Mount, then a state update in Counter, then a context change from App.
  expect(output.commits.slice(1)).toEqual([
    [
      { name: "Counter", unnecessary: false },
      { name: "Leaf", unnecessary: true },
    ],
    [
      { name: "App", unnecessary: false },
      { name: "Counter", unnecessary: true },
      { name: "Leaf", unnecessary: true },
      { name: "Themed", unnecessary: false },
    ],
  ]);
  expect(byName(output, "MemoLeaf")).toMatchObject({ renders: 1, reason: "mount" });
  expect(byName(output, "Themed")).toMatchObject({ renders: 2, reason: "context" });
  expect(byName(output, "App")).toMatchObject({
    reason: "state",
    hooks: ['state #1: "light"', "effect"],
  });
  expect(byName(output, "Counter")?.hooks).toEqual(["state #1: 1", "effect"]);
  // Screen boxes come from OpenTUI's renderables: Leaf is the second line of Counter.
  expect(byName(output, "Leaf")?.rect).toEqual({ x: 0, y: 1, width: 30, height: 1 });
  // Flight's `_debugInfo` names the Server Component that produced an element.
  expect(byName(output, "NotePage")).toMatchObject({ kind: "server", env: "Server" });
}, 30_000);

test("with DEV=true the hook chains onto React DevTools' own", async () => {
  const output = await run({ DEV: "true" });
  expect(output.owner).toBe("react-devtools");
  expect(output.renderers).toBe(1);
  expect(output.commits.length).toBe(3);
}, 30_000);

const Hooks = z.object({
  counts: z.record(z.string(), z.number()),
  hooks: z.array(z.string()),
  source: z.string(),
});
test("hook names follow the build's annotation, around a package's own hooks", async () => {
  const output = Hooks.parse(await spawnFixture("tests/devtools-hooks-fixture.tsx"));
  // The node counts the naming relies on, for the pinned react-reconciler.
  expect(output.counts).toEqual(
    Object.fromEntries(Object.keys(output.counts).map((hook) => [hook, PRIMITIVE_NODES[hook]])),
  );
  expect(output.hooks).toEqual([
    'draft: "abc"',
    "local › open: false",
    "local › input: ref null",
    // A package's hook: its nodes are its own, unnamed inside.
    "usePackage › state: 1",
    "usePackage › state: 2",
    "total: 42",
    "useEffect: effect",
  ]);
  expect(output.source).toBe("fixture.tsx:75");
}, 30_000);
