import { expect, test } from "bun:test";
import { configureFiles } from "../packages/core/src/web/node/files";
import * as fs from "../packages/core/src/web/node/fs";
import { rejectionOf } from "./helpers";

const text = (value: string) => Buffer.from(value).toString("base64");
const MTIME = 1_750_000_000_000;

// What examples/mdreader and examples/files ask of node:fs, answered from a snapshot.
test("the in-browser Server reads a snapshot as it would a disk", async () => {
  configureFiles([
    { path: "/docs/README.md", kind: "file", size: 8, mtimeMs: MTIME, content: text("# Hello\n") },
    { path: "/docs/guide/intro.md", kind: "file", size: 5, mtimeMs: MTIME, content: text("intro") },
    { path: "/docs/empty", kind: "directory", size: 0, mtimeMs: MTIME },
  ]);
  expect(fs.readdirSync("/docs").toSorted((a, b) => a.localeCompare(b))).toEqual([
    "empty",
    "guide",
    "README.md",
  ]);
  const dirents = await fs.promises.readdir("/docs/guide", { withFileTypes: true });
  expect(dirents.map((d) => [d.name, d.isFile(), d.isDirectory()])).toEqual([
    ["intro.md", true, false],
  ]);

  const info = await fs.promises.stat("/docs/README.md");
  expect([info.isFile(), info.isDirectory(), info.size, info.mtimeMs]).toEqual([
    true,
    false,
    8,
    MTIME,
  ]);
  expect((await fs.promises.lstat("/docs")).isDirectory()).toBe(true);
  expect(await fs.promises.readFile("/docs/README.md", "utf8")).toBe("# Hello\n");
  expect(fs.readFileSync("docs/guide/intro.md", { encoding: "utf8" })).toBe("intro");
  expect(await fs.promises.realpath("/docs/guide/../README.md")).toBe("/docs/README.md");

  // A preview reads the head of a file through a handle.
  const handle = await fs.promises.open("/docs/README.md", "r");
  const head = new Uint8Array(4);
  expect((await handle.read(head, 0, 4, 0)).bytesRead).toBe(4);
  expect(new TextDecoder().decode(head)).toBe("# He");
  await handle.close();

  // Node's error codes, which Server code tests.
  expect(await rejectionOf(fs.promises.stat("/docs/missing.md"))).toMatchObject({ code: "ENOENT" });
  expect(await rejectionOf(fs.promises.readlink("/docs/README.md"))).toMatchObject({
    code: "EINVAL",
  });
  expect(await rejectionOf(fs.promises.open("/docs/README.md", "w"))).toMatchObject({
    code: "EROFS",
  });
  expect(() => fs.readdirSync("/docs/README.md")).toThrow("ENOTDIR");
  expect(fs.existsSync("/docs/empty")).toBe(true);

  // A snapshot never changes: its watchers never fire, and close.
  const watcher = fs.watch();
  expect(() => watcher.close()).not.toThrow();
});

test("a page without a snapshot has no files, as before", () => {
  configureFiles([]);
  expect(fs.existsSync("/anything")).toBe(false);
  expect(() => fs.readFileSync("/anything")).toThrow("ENOENT");
  expect(fs.readdirSync("/")).toEqual([]);
});
