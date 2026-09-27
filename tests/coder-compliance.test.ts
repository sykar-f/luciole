import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// The rules of docs/CODER-HANDOFF.md §3, checked on the harness adapters and on every
// example that drives them: whatever a future change adds, these strings would say a
// rule is broken. Paths are relative to the harness package's src/.
const ROOT = resolve("packages/harness/src");
const EXAMPLES = ["examples/coder"].map((dir) => resolve(dir));
const sources = [
  ...[...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: ROOT })].map((file) => ({
    file,
    text: readFileSync(join(ROOT, file), "utf8"),
  })),
  ...EXAMPLES.flatMap((dir) =>
    [...new Bun.Glob("{app,actions,components,server}/**/*.{ts,tsx}").scanSync({ cwd: dir })].map(
      (file) => ({ file: `${dir}/${file}`, text: readFileSync(join(dir, file), "utf8") }),
    ),
  ),
];
/** Lines of code (comments excluded) matching `pattern`, with where they are. */
const offending = (pattern: RegExp) =>
  sources.flatMap(({ file, text }) =>
    text
      .split("\n")
      .map((line, i) => ({
        line: line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, ""),
        at: `${file}:${i + 1}`,
      }))
      .filter(({ line }) => pattern.test(line))
      .map(({ at }) => at),
  );

test("no credential file, keychain or OAuth endpoint is ever touched", () => {
  expect(sources.length).toBeGreaterThan(10);
  expect(offending(/\.credentials\.json|find-generic-password|Keychain|security\s+find/i)).toEqual(
    [],
  );
  expect(offending(/api\.anthropic\.com|\/api\/oauth|oauth\/token/i)).toEqual([]);
  // Harness logins: the type of an entry, or whether a value has the OAuth prefix, asked
  // through jq in anthropic-guard.ts; never a file read into coder.
  expect(offending(/auth\.json/).filter((at) => !at.startsWith("anthropic-guard.ts"))).toEqual([]);
  const guard = readFileSync(join(ROOT, "anthropic-guard.ts"), "utf8");
  expect(/readFile|\.text\(\)|\.json\(\)|Bun\.file\([^)]*\)\.(text|json|bytes)/.test(guard)).toBe(
    false,
  );
  // Every path to those files goes to jq.
  for (const line of guard.split("\n").filter((l) => /join\([^)]*"(auth|models)\.json"/.test(l)))
    expect(line).toContain("ask(");
});

test("Claude Code runs as published: the user's binary, the whole environment, no --bare", () => {
  expect(offending(/--bare|["']bare["']/)).toEqual([]);
  const claude = readFileSync(join(ROOT, "adapters/claude.ts"), "utf8");
  expect(/pathToClaudeCodeExecutable: claude\b/.test(claude)).toBe(true);
  expect(/env: \{\s*\.\.\.this\.context\.env/.test(claude)).toBe(true);
  // HOME stays the user's: the keychain login depends on it.
  expect(offending(/\bHOME\s*:/)).toEqual([]);
});

test("Codex is told who drives it: an honest client name, its own login flow", () => {
  const codex = readFileSync(join(ROOT, "adapters/codex.ts"), "utf8");
  expect(codex).toContain('name: this.options.client ?? "airtty-coder"');
  // Signed out: the user runs Codex's own login, coder never handles its tokens.
  expect(codex).toContain("run `codex login`");
  expect(offending(/chatgptAuthTokens|account\/login\/start/)).toEqual([]);
});

test("opencode: its own server, locked to coder, never sharing a session publicly", () => {
  const opencode = readFileSync(join(ROOT, "adapters/opencode.ts"), "utf8");
  // A random password per launch: no other local process drives the agent.
  expect(opencode).toContain("const password = crypto.randomUUID();");
  expect(opencode).toContain("OPENCODE_SERVER_PASSWORD: password");
  expect(opencode).toContain('"--hostname=127.0.0.1"');
  expect(opencode).toContain('share: "disabled"');
  expect(offending(/\/share\b/)).toEqual([]);
  // The user signs in with opencode's own command.
  expect(readFileSync(join(ROOT, "detect.ts"), "utf8")).toContain("run `opencode auth login`");
});
