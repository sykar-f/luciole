/**
 * Bun.build plugin that builds @opentui/core from its sources against opentui.wasm
 * (docs/WEB.md, W7 and decision 4). Each substitution names the source it expects and
 * fails the build when that source changed: a new OpenTUI version is a new ABI key, and
 * this is where it is checked.
 */
import type { BunPlugin } from "bun";
import { join } from "node:path";

const FFI = join(import.meta.dir, "ffi.ts");
const ASSETS = join(import.meta.dir, "runtime-assets.ts");

function replace(file: string, text: string, from: string | RegExp, to: string) {
  const next = text.replace(from, to);
  if (next === text) throw new Error(`opentui-wasm: ${file} no longer contains ${String(from)}`);
  return next;
}

export const opentuiWasm: BunPlugin = {
  name: "opentui-wasm",
  setup(build) {
    build.onResolve({ filter: /(^|\/)platform\/ffi(\.js|\.ts)?$/ }, () => ({ path: FFI }));
    build.onResolve({ filter: /^#opentui\/runtime-assets$/ }, () => ({ path: ASSETS }));

    // bun-ffi-structs 0.3.1 still picks its backend and pointer size.
    build.onLoad({ filter: /bun-ffi-structs\/dist\/index\.js$/ }, async (args) => {
      let text = await Bun.file(args.path).text();
      text = replace(
        args.path,
        text,
        "var backend = await loadBackend();",
        "var backend = __opentuiWasmFfi;",
      );
      text = replace(
        args.path,
        text,
        `var pointerSize = process.arch === "x64" || process.arch === "arm64" ? 8 : 4;`,
        "var pointerSize = 4;",
      );
      return {
        loader: "js",
        contents: `import * as __opentuiWasmFfi from ${JSON.stringify(FFI)};\n${text}`,
      };
    });

    // Scene measurement callbacks write their dimensions through a native pointer.
    // That view must alias WASM memory; a copied ArrayBuffer loses the result.
    build.onLoad({ filter: /packages\/core\/src\/zig\.ts$/ }, async (args) => {
      let text = await Bun.file(args.path).text();
      text = replace(args.path, text, "if (!existsSync(targetLibPath)) {", "if (false) {");
      text = replace(
        args.path,
        text,
        "new Float32Array(toArrayBuffer(output, 0, 8)).set(dimensions)",
        "typedView(Float32Array, output, 8).set(dimensions)",
      );
      text = `import { typedView } from ${JSON.stringify(FFI)}\n${text}`;
      return { loader: "ts", contents: text };
    });

    // 0.6.6 reads cells through a scoped snapshot (lib/buffer-access.ts): live views, as
    // Bun's toArrayBuffer gives, instead of copies.
    build.onLoad({ filter: /packages\/core\/src\/lib\/buffer-access\.ts$/ }, async (args) => {
      let text = await Bun.file(args.path).text();
      for (const [type, name, bytes] of [
        ["Uint32Array", "char", "4"],
        ["Uint16Array", "fg", "8"],
        ["Uint16Array", "bg", "8"],
        ["Uint32Array", "attributes", "4"],
      ])
        text = replace(
          args.path,
          text,
          `new ${type}(toArrayBuffer(value.${name}, 0, value.width * value.height * ${bytes}))`,
          `typedView(${type}, value.${name}, value.width * value.height * ${bytes})`,
        );
      text = `import { typedView } from ${JSON.stringify(FFI)}\n${text}`;
      return { loader: "ts", contents: text };
    });

    // NativeSpanFeed chunks: copied when drained (no stateBuffer alias in 0.6.6).
    build.onLoad({ filter: /packages\/core\/src\/NativeSpanFeed\.ts$/ }, async (args) => {
      let text = await Bun.file(args.path).text();
      text = replace(
        args.path,
        text,
        "  private chunkMap = new Map<Pointer, ArrayBuffer>()",
        "  private chunkMap = new Map<Pointer, { byteLength: number }>()",
      );
      text = replace(
        args.path,
        text,
        "              const buffer = toArrayBuffer(arg0, 0, chunkLen)\n              this.chunkMap.set(arg0, buffer)",
        "              this.chunkMap.set(arg0, { byteLength: chunkLen })",
      );
      text = replace(
        args.path,
        text,
        "          const slice = new Uint8Array(buffer, span.offset, span.len)",
        "          const slice = new Uint8Array(toArrayBuffer(span.chunkPtr, span.offset, span.len))",
      );
      return { loader: "ts", contents: text };
    });
  },
};
