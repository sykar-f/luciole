/** Installed core must create resources with one resolved renderer dependency. */
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { checkPackage } from "../scripts/pack-check";

const TIMEOUT_MS = 240_000;
test(
  "packed core imports and creates a renderer-owned style",
  async () => {
    expect(await checkPackage(resolve("packages/core"), console.log)).toEqual([]);
  },
  TIMEOUT_MS,
);
