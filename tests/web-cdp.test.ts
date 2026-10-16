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

test("Chrome can start at a real device scale", () => {
  expect(chromeArgs("/tmp/scale-profile", 2)).toContain("--force-device-scale-factor=2");
  expect(chromeArgs("/tmp/scale-profile")).not.toContain("--force-device-scale-factor=2");
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

test("a debugging port needs a complete valid first line", async () => {
  using directory = temporaryDirectory("cdp-port-");
  const path = join(directory.path, "DevToolsActivePort");
  const port = 32123;
  const states = [
    "32",
    "0\n",
    "65536\n",
    "-1\n",
    "1.5\n",
    "invalid\n",
    `${port}\n/devtools/browser/test\n`,
  ];
  writeFileSync(path, states[0] ?? "");
  const seen: string[] = [];
  const result = await chromePort(path, performance.now() + 1000, async () => {
    const contents = await Bun.file(path).text();
    seen.push(contents);
    // Each update is acknowledged by the reader, including the partial first line.
    const next = states[seen.length];
    if (next !== undefined) writeFileSync(path, next);
    return contents;
  });
  expect(result).toBe(port);
  expect(seen).toEqual(states);
});

test("an incomplete debugging port file keeps the startup deadline", async () => {
  using directory = temporaryDirectory("cdp-port-");
  const path = join(directory.path, "DevToolsActivePort");
  writeFileSync(path, "");
  const reading = chromePort(path, performance.now() - 1);
  expect(reading).rejects.toThrow("did not start");
  await reading.catch(() => {});
});
