/**
 * The alternative to the deprecated sandbox-exec: a launcher sandboxes itself with
 * sandbox_init_with_parameters (libsandbox, re-exported by libSystem; private API, the
 * one sandbox-exec wraps) through bun:ffi, then runs the child's code in-process.
 * Usage: bun sandbox-init.ts <profile file> <file to read>. Prints one JSON line.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { readFileSync } from "node:fs";

const EXCERPT_CHARS = 20;
const [profileFile = "", target = ""] = process.argv.slice(2);
const lib = dlopen("/usr/lib/libSystem.B.dylib", {
  sandbox_init_with_parameters: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
});
const profile = Buffer.from(`${readFileSync(profileFile, "utf8")}\0`);
// A NULL-terminated parameter list (none) and the error out-pointer.
const params = new BigUint64Array(1);
const error = new BigUint64Array(1);
const status = lib.symbols.sandbox_init_with_parameters(ptr(profile), 0, ptr(params), ptr(error));
let detail: string;
let ok = false;
try {
  detail = readFileSync(target, "utf8").slice(0, EXCERPT_CHARS);
  ok = true;
} catch (e) {
  detail = e instanceof Error ? e.message : String(e);
}
console.log(JSON.stringify({ ok, detail: `sandbox_init=${status} ${detail}` }));
