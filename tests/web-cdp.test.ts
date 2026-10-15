import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { temporaryDirectory } from "../scripts/pty/harness";
import { chromeArgs, chromePort } from "../scripts/web/cdp";

test("headless Chrome uses a mock keychain for fresh profiles", () => {
  const args = chromeArgs("/tmp/fresh-chrome-profile");
  expect(args).toContain("--use-mock-keychain");
  expect(args).toContain("--user-data-dir=/tmp/fresh-chrome-profile");
});

test("an existing empty debugging port file is not ready", async () => {
  using directory = temporaryDirectory("cdp-port-");
  const path = join(directory.path, "DevToolsActivePort");
  const port = 32123;
  writeFileSync(path, "");
  const seen: string[] = [];
  const result = await chromePort(path, performance.now() + 1000, async () => {
    const contents = await Bun.file(path).text();
    seen.push(contents);
    // The writer publishes the port only after the reader acknowledges the empty file.
    if (contents === "") writeFileSync(path, `${port}\n`);
    return contents;
  });
  expect(result).toBe(port);
  expect(seen).toEqual(["", `${port}\n`]);
});
