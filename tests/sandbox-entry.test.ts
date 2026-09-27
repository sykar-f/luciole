/** `airtty/sandbox` and the publisher keys of `airtty/build`, as a host outside the framework imports them. */
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as build from "airtty/build";
import * as sandbox from "airtty/sandbox";
import { TerminalView } from "airtty/client";

test("airtty/sandbox exports what a host needs to confine a Client and a Server", () => {
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

test("airtty/build makes and reads a publisher key where AIRTTY_PUBLISHER_KEY says", () => {
  const dir = mkdtempSync(join(tmpdir(), "airtty-key-"));
  try {
    const env = { AIRTTY_PUBLISHER_KEY: join(dir, "keys/project.pem") };
    const made = build.generatePublisherKey(env);
    const read = build.readPublisherKey(env);
    expect(build.fingerprintOf(read.publicKey)).toBe(made.fingerprint);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
