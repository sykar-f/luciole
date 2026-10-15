import { expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareOpenTuiCheckout } from "../packages/core/src/web-runtime";

function fixture(run: (source: string, checkout: string, directory: string) => void) {
  const directory = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "web-runtime-clone-"));
  const source = join(directory, "source");
  const checkout = join(directory, "checkout");
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: source, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  try {
    mkdirSync(source);
    git("init", "--quiet");
    writeFileSync(join(source, "tracked.txt"), "original\n");
    git("add", ".");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    );
    git("tag", "fixture");
    run(source, checkout, directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("replaces a poisoned checkout whose .git has no HEAD", () => {
  fixture((source, checkout) => {
    mkdirSync(join(checkout, ".git"), { recursive: true });
    writeFileSync(join(checkout, "interrupted"), "partial clone");
    prepareOpenTuiCheckout(checkout, source, "fixture");
    expect(readFileSync(join(checkout, "tracked.txt"), "utf8")).toBe("original\n");
    expect(existsSync(join(checkout, "interrupted"))).toBe(false);
  });
});

test("replaces a checkout with HEAD but missing tracked files", () => {
  fixture((source, checkout) => {
    prepareOpenTuiCheckout(checkout, source, "fixture");
    rmSync(join(checkout, "tracked.txt"));
    prepareOpenTuiCheckout(checkout, source, "fixture");
    expect(readFileSync(join(checkout, "tracked.txt"), "utf8")).toBe("original\n");
  });
});

test("reuses complete checkouts and preserves applied patches", () => {
  fixture((source, checkout) => {
    prepareOpenTuiCheckout(checkout, source, "fixture");
    writeFileSync(join(checkout, "tracked.txt"), "patched\n");
    prepareOpenTuiCheckout(checkout, join(source, "unavailable"), "fixture");
    expect(readFileSync(join(checkout, "tracked.txt"), "utf8")).toBe("patched\n");
  });
});

test("a failed git clone removes its temporary directory and leaves no final checkout", () => {
  fixture((source, checkout, directory) => {
    expect(() => prepareOpenTuiCheckout(checkout, source, "missing-tag")).toThrow();
    expect(existsSync(checkout)).toBe(false);
    expect(readdirSync(directory)).toEqual(["source"]);
  });
});

test("a clone interrupted after writing files never publishes a checkout", () => {
  fixture((source, checkout, directory) => {
    const spawn = Bun.spawnSync;
    // Clone real local sources, then simulate a failure after git wrote its files.
    const interrupted: typeof spawn = (command) => {
      const result = Array.isArray(command) ? spawn(command) : spawn(command);
      const args = Array.isArray(command) ? command : command.cmd;
      if (args[1] === "clone") {
        expect(existsSync(checkout)).toBe(false);
        throw new Error("interrupted clone");
      }
      return result;
    };
    const clone = spyOn(Bun, "spawnSync").mockImplementation(interrupted);
    try {
      expect(() => prepareOpenTuiCheckout(checkout, source, "fixture")).toThrow(
        "interrupted clone",
      );
    } finally {
      clone.mockRestore();
    }
    expect(existsSync(checkout)).toBe(false);
    expect(readdirSync(directory)).toEqual(["source"]);
    prepareOpenTuiCheckout(checkout, source, "fixture");
    expect(readFileSync(join(checkout, "tracked.txt"), "utf8")).toBe("original\n");
  });
});
