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
    // OpenTUI's FFI surface.
    build.onResolve({ filter: /(^|\/)platform\/ffi(\.js|\.ts)?$/ }, () => ({ path: FFI }));
    build.onResolve({ filter: /^#opentui\/runtime-assets$/ }, () => ({ path: ASSETS }));

    // wasm32: pointers are 4 bytes in every extern struct.
    // bun-ffi-structs picks bun:ffi or node:ffi by a dynamic import at load: it gets this
    // backend instead, and wasm32's 4-byte pointers in every extern struct.
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

    build.onLoad({ filter: /packages\/core\/src\/zig\.ts$/ }, async (args) => {
      let text = await Bun.file(args.path).text();
      // Native code keeps these bytes: a copy that lives as long as the view.
      text = replace(
        args.path,
        text,
        "  void value.buffer\n  return ptr(value)\n",
        "  return retainPtr(value)\n",
      );
      text = `import { retainPtr } from ${JSON.stringify(FFI)}\n${text}`;
      // No file to check: the module is already instantiated.
      text = replace(args.path, text, "if (!existsSync(targetLibPath)) {", "if (false) {");
      // A line-info pointer read as 8 bytes: in wasm32 its upper half is the length that
      // follows, and the gutter of <code> and <diff> gets no line sources to number.
      text = replace(
        args.path,
        text,
        "toPointer(data.getBigUint64(sources.arrayOffset, true))",
        "toPointer(data.getUint32(sources.arrayOffset, true))",
      );
      return { loader: "ts", contents: text };
    });

    // NativeSpanFeed aliases native memory twice (NativeSpanFeed.ts: "toArrayBuffer must
    // alias Zig memory"): the refcounts it writes for Zig, and chunks written after they are
    // announced. Refcounts: a live view, made again on each use (memory.grow detaches it).
    // Chunk data: copied when drained, so a buffered write outlives the chunk's reuse.
    build.onLoad({ filter: /packages\/core\/src\/NativeSpanFeed\.ts$/ }, async (args) => {
      let text = await Bun.file(args.path).text();
      text = replace(
        args.path,
        text,
        "  private stateBuffer: Uint8Array | null = null\n",
        [
          "  private stateView: { ptr: Pointer; len: number } | null = null",
          "  private get stateBuffer(): Uint8Array | null {",
          "    return this.stateView && typedView(Uint8Array, this.stateView.ptr, this.stateView.len)",
          "  }",
          "  private set stateBuffer(value: null) {",
          "    this.stateView = value",
          "  }",
          "",
        ].join("\n"),
      );
      text = replace(
        args.path,
        text,
        "            const buffer = toArrayBuffer(arg0, 0, len)\n            this.stateBuffer = new Uint8Array(buffer)",
        "            this.stateView = { ptr: arg0, len }",
      );
      text = replace(
        args.path,
        text,
        /        let buffer = this\.chunkMap\.get\(span\.chunkPtr\)[\s\S]*?const slice = new Uint8Array\(buffer, span\.offset, span\.len\)/,
        [
          "        const size = this.chunkSizes.get(span.chunkPtr)",
          "        if (!size || span.offset + span.len > size) continue",
          "        const slice = new Uint8Array(toArrayBuffer(span.chunkPtr, span.offset, span.len))",
        ].join("\n"),
      );
      text = `import { typedView } from ${JSON.stringify(FFI)}\n${text}`;
      return { loader: "ts", contents: text };
    });

    // Live views on the cells, as Bun's toArrayBuffer gives, recreated after memory.grow.
    build.onLoad({ filter: /packages\/core\/src\/buffer\.ts$/ }, async (args) => {
      let text = await Bun.file(args.path).text();
      text = replace(
        args.path,
        text,
        "    if (this._rawBuffers !== null) {\n      return\n    }",
        "    if (this._rawBuffers !== null && (this._rawBuffers.char.length !== 0 || this._width * this._height === 0)) {\n      return\n    }",
      );
      for (const [type, name, bytes] of [
        ["Uint32Array", "charPtr", "size * 4"],
        ["Uint16Array", "fgPtr", "size * 4 * 2"],
        ["Uint16Array", "bgPtr", "size * 4 * 2"],
        ["Uint32Array", "attributesPtr", "size * 4"],
      ])
        text = replace(
          args.path,
          text,
          `new ${type}(toArrayBuffer(${name}, 0, ${bytes}))`,
          `typedView(${type}, ${name}, ${bytes})`,
        );
      text = `import { typedView } from ${JSON.stringify(FFI)}\n${text}`;
      return { loader: "ts", contents: text };
    });
  },
};
