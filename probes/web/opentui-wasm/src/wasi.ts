/**
 * The WASI calls `opentui.wasm` imports (wasi-libc, Zig's std), answered for a browser:
 * clocks, randomness, and stdout/stderr to the console. OpenTUI's output goes through a
 * NativeSpanFeed callback, never through fd 1, and there is no filesystem: every other
 * call fails with ENOSYS, which native code already handles as an I/O error.
 */
const Errno = { success: 0, badf: 8, inval: 28, nosys: 52 } as const;
const Fd = { stdout: 1, stderr: 2 } as const;
const Clock = { realtime: 0 } as const;
const NS_PER_US = 1000n;
const US_PER_MS = 1000;
const CLOCK_RESOLUTION_NS = 1000n;
/** crypto.getRandomValues fills at most this many bytes per call. */
const RANDOM_CHUNK = 65536;
/** An iovec: a u32 address, then a u32 length. */
const IOVEC_BYTES = 8;
const IOVEC_LENGTH_OFFSET = 4;

export class WasiExit extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`opentui.wasm exited with ${code}`);
    this.code = code;
  }
}

type Import = (...args: never[]) => number;

export function wasiImports(memory: () => ArrayBuffer): Record<string, Import> {
  const view = () => new DataView(memory());
  const decoder = new TextDecoder();
  const pending = new Map<number, string>();
  const zero = (a: number, b: number) => {
    view().setUint32(a, 0, true);
    view().setUint32(b, 0, true);
    return Errno.success;
  };
  const answered: Record<string, Import> = {
    args_sizes_get: zero,
    args_get: () => Errno.success,
    environ_sizes_get: zero,
    environ_get: () => Errno.success,
    clock_res_get(_id: number, resolution: number) {
      view().setBigUint64(resolution, CLOCK_RESOLUTION_NS, true);
      return Errno.success;
    },
    clock_time_get(id: number, _precision: bigint, time: number) {
      // Monotonic, process and thread clocks all read the page's monotonic clock.
      const ms = id === Clock.realtime ? Date.now() : performance.now();
      view().setBigUint64(time, BigInt(Math.round(ms * US_PER_MS)) * NS_PER_US, true);
      return Errno.success;
    },
    random_get(buffer: number, length: number) {
      const bytes = new Uint8Array(memory(), buffer, length);
      for (let offset = 0; offset < length; offset += RANDOM_CHUNK)
        crypto.getRandomValues(bytes.subarray(offset, Math.min(length, offset + RANDOM_CHUNK)));
      return Errno.success;
    },
    fd_write(fd: number, iovs: number, count: number, written: number) {
      if (fd !== Fd.stdout && fd !== Fd.stderr) return Errno.badf;
      const dv = view();
      let total = 0;
      let text = pending.get(fd) ?? "";
      for (let i = 0; i < count; i++) {
        const base = dv.getUint32(iovs + i * IOVEC_BYTES, true);
        const length = dv.getUint32(iovs + i * IOVEC_BYTES + IOVEC_LENGTH_OFFSET, true);
        text += decoder.decode(new Uint8Array(memory(), base, length), { stream: true });
        total += length;
      }
      const lines = text.split("\n");
      pending.set(fd, lines.pop() ?? "");
      const log = fd === Fd.stdout ? console.log : console.error;
      for (const line of lines) log(`[opentui] ${line}`);
      dv.setUint32(written, total, true);
      return Errno.success;
    },
    fd_fdstat_get: () => Errno.badf,
    fd_prestat_get: () => Errno.badf,
    poll_oneoff: () => Errno.inval,
    proc_exit(code: number) {
      throw new WasiExit(code);
    },
  };
  return new Proxy(answered, {
    get: (target, key) => (typeof key === "string" && target[key]) || (() => Errno.nosys),
  });
}
