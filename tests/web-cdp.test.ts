import { expect, test } from "bun:test";
import { chromeArgs } from "../scripts/web/cdp";

test("headless Chrome uses a mock keychain for fresh profiles", () => {
  const args = chromeArgs("/tmp/fresh-chrome-profile");
  expect(args).toContain("--use-mock-keychain");
  expect(args).toContain("--user-data-dir=/tmp/fresh-chrome-profile");
});
