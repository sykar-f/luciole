/** `@luciole-sh/core/sandbox` and the publisher keys of `@luciole-sh/core/build`, as a host outside the framework imports them. */
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as build from "@luciole-sh/core/build";
import * as sandbox from "@luciole-sh/core/sandbox";
import { TerminalView } from "@luciole-sh/core/client";

test("@luciole-sh/core/sandbox exports what a host needs to confine a Client and a Server", () => {
  for (const name of [
    "openSandbox",
    "confineServer",
    "freeLoopbackPort",
    "buildChild",
    "sandboxAvailability",
    "sandboxRuntime",
    "enforcement",
    "mechanismName",
  ] as const)
    expect(typeof sandbox[name]).toBe("function");
  expect(sandbox.Capabilities.parse({}).net).toEqual([]);
  // The widget that shows it is a component, with the others.
  expect(typeof TerminalView).toBe("function");
});

test("@luciole-sh/core/build makes and reads a publisher key where LUCIOLE_PUBLISHER_KEY says", () => {
  const dir = mkdtempSync(join(tmpdir(), "luciole-key-"));
  try {
    const env = { LUCIOLE_PUBLISHER_KEY: join(dir, "keys/project.pem") };
    const made = build.generatePublisherKey(env);
    const read = build.readPublisherKey(env);
    expect(build.fingerprintOf(read.publicKey)).toBe(made.fingerprint);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
