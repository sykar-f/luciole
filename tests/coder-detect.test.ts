import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detect } from "../examples/coder/server/detect";

// A stand-in `claude` on a PATH of its own: what it prints is what 2.1.283 prints.
let bin: string;
const stub = async (name: string, script: string) => {
  const file = join(bin, name);
  await Bun.write(file, `#!/bin/sh\n${script}\n`);
  await chmod(file, 0o755);
};
beforeAll(async () => {
  bin = await mkdtemp(join(tmpdir(), "coder-detect-"));
});
afterAll(() => rm(bin, { recursive: true, force: true }));
const env = (extra: Record<string, string> = {}) => ({ PATH: `${bin}:/usr/bin:/bin`, ...extra });

test("claude: installed, versioned and signed in, from its own commands", async () => {
  await stub(
    "claude",
    `case "$1" in
  --version) echo "2.1.283 (Claude Code)";;
  auth) echo '{"loggedIn":true,"authMethod":"claude.ai","email":"ada@example.com","subscriptionType":"max"}';;
esac`,
  );
  expect(await detect("claude", env())).toEqual({
    id: "claude",
    installed: true,
    version: "2.1.283",
    ready: true,
    account: "ada@example.com · max",
    fix: undefined,
    warnings: [],
  });
  // An API key in the environment is billed instead of the subscription: said, not read.
  const keyed = await detect("claude", env({ ANTHROPIC_API_KEY: "sk-ant-api-test" }));
  expect(keyed.warnings).toEqual([
    "ANTHROPIC_API_KEY is set: Claude Code bills it instead of your subscription",
  ]);
  expect(JSON.stringify(keyed)).not.toContain("sk-ant-api-test");
});

test("claude: signed out, the fix is Anthropic's own login; missing, where to get it", async () => {
  await stub(
    "claude",
    `case "$1" in
  --version) echo "2.1.283 (Claude Code)";;
  auth) echo '{"loggedIn":false,"authMethod":"none"}'; exit 1;;
esac`,
  );
  expect(await detect("claude", env())).toMatchObject({
    installed: true,
    ready: false,
    fix: "run `claude auth login` in a terminal",
  });
  await rm(join(bin, "claude"));
  expect(await detect("claude", { PATH: bin })).toMatchObject({ installed: false, ready: false });
});
