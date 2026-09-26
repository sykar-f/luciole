import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// The rules of docs/CODER-HANDOFF.md §3, checked on coder's sources: whatever a future
// change adds, these strings would say a rule is broken.
const ROOT = resolve("examples/coder");
const sources = [
  ...new Bun.Glob("{app,actions,components,server}/**/*.{ts,tsx}").scanSync({ cwd: ROOT }),
].map((file) => ({ file, text: readFileSync(join(ROOT, file), "utf8") }));
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
  // Harness logins: the type of an entry at most, never read here whole.
  expect(offending(/auth\.json/)).toEqual([]);
});

test("Claude Code runs as published: the user's binary, the whole environment, no --bare", () => {
  expect(offending(/--bare|["']bare["']/)).toEqual([]);
  const claude = readFileSync(join(ROOT, "server/adapters/claude.ts"), "utf8");
  expect(/pathToClaudeCodeExecutable: claude\b/.test(claude)).toBe(true);
  expect(/env: \{\s*\.\.\.this\.context\.env/.test(claude)).toBe(true);
  // HOME stays the user's: the keychain login depends on it.
  expect(offending(/\bHOME\s*:/)).toEqual([]);
});

test("Codex is told who drives it: an honest client name, its own login flow", () => {
  const codex = readFileSync(join(ROOT, "server/adapters/codex.ts"), "utf8");
  expect(/clientInfo: \{ name: "airtty-coder"/.test(codex)).toBe(true);
  // Signed out: the user runs Codex's own login, coder never handles its tokens.
  expect(codex).toContain("run `codex login`");
  expect(offending(/chatgptAuthTokens|account\/login\/start/)).toEqual([]);
});
