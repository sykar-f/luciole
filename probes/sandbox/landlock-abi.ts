/**
 * The kernel's Landlock ABI (Linux only): landlock_create_ruleset(NULL, 0,
 * LANDLOCK_CREATE_RULESET_VERSION) returns it, or fails when Landlock is off (-1 → 0).
 */
import { dlopen, FFIType } from "bun:ffi";

const SYS_LANDLOCK_CREATE_RULESET = 444; // same number on x86_64 and aarch64
const LANDLOCK_CREATE_RULESET_VERSION = 1;

export function landlockAbi() {
  const libc = dlopen("libc.so.6", {
    syscall: { args: [FFIType.i64, FFIType.ptr, FFIType.u64, FFIType.u32], returns: FFIType.i64 },
  });
  try {
    const abi = Number(
      libc.symbols.syscall(SYS_LANDLOCK_CREATE_RULESET, null, 0, LANDLOCK_CREATE_RULESET_VERSION),
    );
    return Math.max(abi, 0);
  } finally {
    libc.close();
  }
}
