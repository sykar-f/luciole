/** Installed core must create resources with one resolved renderer dependency. */
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPackage } from "../scripts/pack-check";

import { copyPackWorkspace } from "./pack-workspace";

const temp = await mkdtemp(join(tmpdir(), "core-package-"));
afterAll(() => rm(temp, { recursive: true, force: true }));
const workspace = await copyPackWorkspace(join(temp, "workspace"));

const TIMEOUT_MS = 240_000;
test(
  "packed core imports and creates a renderer-owned style",
  async () => {
    expect(await checkPackage(join(workspace, "packages/core"), console.log)).toEqual([]);
  },
  TIMEOUT_MS,
);
