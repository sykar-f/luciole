/**
 * `luciole` metadata of an application's package.json (src/app-metadata.ts): read and
 * checked before the build, written into its output for hosts.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_ICON,
  APP_METADATA,
  AppMetadata,
  readAppDeclaration,
  writeAppMetadata,
} from "../packages/luciole/src/app-metadata";
import { rejectionOf } from "./helpers";

const work = await mkdtemp(join(tmpdir(), "luciole-metadata-"));
afterAll(() => rm(work, { recursive: true, force: true }));

/** The start of a PNG: what the check reads, its signature and IHDR size. */
function pngHeader(width: number, height: number) {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

let count = 0;
async function app(pkg: unknown, files: Record<string, Uint8Array | string> = {}) {
  const root = join(work, `app-${count++}`, "notes");
  await mkdir(join(root, "assets"), { recursive: true });
  await Bun.write(join(root, "package.json"), JSON.stringify(pkg));
  for (const [path, content] of Object.entries(files)) await Bun.write(join(root, path), content);
  return root;
}

test("without a declaration, the directory's name is the display name", async () => {
  const declaration = await readAppDeclaration(await app({ name: "notes" }));
  expect(declaration.metadata).toEqual({ format: 1, name: "notes", displayName: "notes" });
  expect(declaration.iconFile).toBeUndefined();
});

test("display name, identifier, icon, and the package's version and description", async () => {
  const root = await app(
    {
      version: "1.2.0",
      description: "Personal notebook",
      luciole: {
        displayName: "Notes",
        identifier: "com.example.notes",
        icon: "assets/icon.png",
        capabilities: { notify: true },
      },
    },
    { "assets/icon.png": pngHeader(1024, 1024) },
  );
  const declaration = await readAppDeclaration(root);
  expect(declaration.capabilities?.notify).toBe(true);
  const output = join(root, ".luciole");
  await mkdir(output);
  await writeAppMetadata(output, declaration);
  const written = AppMetadata.parse(JSON.parse(await readFile(join(output, APP_METADATA), "utf8")));
  expect(written).toEqual({
    format: 1,
    name: "notes",
    displayName: "Notes",
    identifier: "com.example.notes",
    version: "1.2.0",
    description: "Personal notebook",
    icon: APP_ICON,
  });
  expect(await Bun.file(join(output, APP_ICON)).bytes()).toEqual(pngHeader(1024, 1024));
});

test.each([
  ["a missing icon", { icon: "assets/none.png" }, {}, "does not exist"],
  [
    "an icon that is not a PNG",
    { icon: "assets/icon.png" },
    { "assets/icon.png": "GIF89a…" },
    "is not a PNG",
  ],
  [
    "a small icon",
    { icon: "assets/icon.png" },
    { "assets/icon.png": pngHeader(256, 256) },
    "256×256",
  ],
  [
    "a wide icon",
    { icon: "assets/icon.png" },
    { "assets/icon.png": pngHeader(1024, 512) },
    "must be square",
  ],
  ["an icon outside the application", { icon: "../icon.png" }, {}, "inside the application"],
  ["an identifier that is not reverse DNS", { identifier: "notes" }, {}, "reverse DNS"],
])("%s fails the build", async (_, luciole, files, message) => {
  const error = await rejectionOf(readAppDeclaration(await app({ luciole }, files)));
  expect(String(error)).toContain(message);
});
