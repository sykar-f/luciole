/** Build targets and cache location shared by runtime preparation and compilation. */
import { homedir } from "node:os";
import { join } from "node:path";

export const COMPILE_TARGETS = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-linux-x64-musl",
  "bun-linux-arm64-musl",
] as const satisfies readonly Bun.Build.CompileTarget[];
export type CompileTarget = (typeof COMPILE_TARGETS)[number];
export const hostTarget = () => `bun-${process.platform}-${process.arch}`;

export const defaultCache = () =>
  join(process.env["XDG_CACHE_HOME"] || join(homedir(), ".cache"), "luciole");
