import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  oauthInEnvironment,
  piAnthropicOAuth,
  withoutOAuth,
} from "../examples/coder/server/anthropic-guard";

// docs/CODER-HANDOFF.md §3.5: every way pi could use a Claude subscription is caught,
// and none of them reads a secret into coder.
let dir: string, pi: string, agent: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "coder-guard-"));
  agent = join(dir, "agent");
  pi = join(dir, "pi");
  await Bun.write(pi, `#!/bin/sh\necho "$PI_AUTH_CHECK"\n`);
  await chmod(pi, 0o755);
});
afterAll(() => rm(dir, { recursive: true, force: true }));
const env = (extra: Record<string, string> = {}) => ({
  PATH: `/usr/bin:/bin:/opt/homebrew/bin:/run/current-system/sw/bin:${process.env.PATH ?? ""}`,
  PI_CODING_AGENT_DIR: agent,
  PI_AUTH_CHECK: '{"status":"not_ready"}',
  ...extra,
});
const NOT_READY = '{"status":"not_ready","provider":"anthropic"}';

test("nothing Anthropic: nothing to block", async () => {
  expect(await piAnthropicOAuth(env({ PI_AUTH_CHECK: NOT_READY }), pi)).toEqual([]);
});

test("pi's own check, and tokens passed by the environment (which it reports as api_key)", async () => {
  expect(
    await piAnthropicOAuth(env({ PI_AUTH_CHECK: '{"status":"ready","authType":"oauth"}' }), pi),
  ).toEqual(["pi is signed in to Anthropic with OAuth"]);
  const passed = env({
    PI_AUTH_CHECK: '{"status":"ready","authType":"api_key"}',
    ANTHROPIC_API_KEY: "sk-ant-oat01-x",
  });
  expect(await piAnthropicOAuth(passed, pi)).toEqual(["ANTHROPIC_API_KEY (an OAuth token) is set"]);
  expect(oauthInEnvironment({ ANTHROPIC_OAUTH_TOKEN: "x", ANTHROPIC_AUTH_TOKEN: "y" })).toEqual([
    "ANTHROPIC_OAUTH_TOKEN",
    "ANTHROPIC_AUTH_TOKEN",
  ]);
  // A real API key is fine: Claude through a key is allowed.
  expect(oauthInEnvironment({ ANTHROPIC_API_KEY: "sk-ant-api03-x" })).toEqual([]);
});

// jq answers about the files; without it, pi's own check stands alone.
test.skipIf(!Bun.which("jq"))(
  "pi's files: the login's type and a token's prefix, asked through jq",
  async () => {
    await Bun.write(
      join(agent, "auth.json"),
      JSON.stringify({ anthropic: { type: "api_key", key: "sk-ant-oat01-SECRET" } }),
    );
    await Bun.write(
      join(agent, "models.json"),
      JSON.stringify({ providers: { anthropic: { apiKey: "sk-ant-oat01-SECRET" } } }),
    );
    const reasons = await piAnthropicOAuth(env({ PI_AUTH_CHECK: NOT_READY }), pi);
    expect(reasons).toEqual([
      "pi's auth.json holds an Anthropic OAuth token",
      "pi's models.json holds an Anthropic OAuth token",
    ]);
    expect(JSON.stringify(reasons)).not.toContain("SECRET");
  },
);

test("the environment pi gets has no Anthropic OAuth token left", () => {
  expect(
    withoutOAuth({
      PATH: "/bin",
      ANTHROPIC_OAUTH_TOKEN: "a",
      ANTHROPIC_AUTH_TOKEN: "b",
      ANTHROPIC_API_KEY: "sk-ant-oat01-c",
      OPENAI_API_KEY: "d",
    }),
  ).toEqual({ PATH: "/bin", OPENAI_API_KEY: "d" });
  expect(withoutOAuth({ ANTHROPIC_API_KEY: "sk-ant-api03-e" })).toEqual({
    ANTHROPIC_API_KEY: "sk-ant-api03-e",
  });
});
