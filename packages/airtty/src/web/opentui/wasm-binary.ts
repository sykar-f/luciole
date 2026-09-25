/**
 * The little of the WebAssembly binary format the FFI backend needs: the limits of the
 * table a module imports (the JS API cannot read them), and a module that imports one
 * JavaScript function with a native signature and exports it back, the portable form of
 * `WebAssembly.Function` for callbacks.
 */
// "\0asm", then version 1.
const HEADER = [...new TextEncoder().encode("\0asm"), 1, 0, 0, 0];
const HEADER_BYTES = HEADER.length;
const SECTION = { type: 1, import: 2, export: 7 } as const;
const EXTERNAL = { function: 0, table: 1, memory: 2, global: 3 } as const;
const FUNCTION_TYPE = 0x60;
const LIMITS_HAS_MAX = 1;
const GLOBAL_DESCRIPTOR_BYTES = 2;
const LEB_PAYLOAD = 0x7f;
const LEB_CONTINUE = 0x80;
const LEB_SHIFT = 7;

export const ValueType = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c } as const;
export type ValueType = (typeof ValueType)[keyof typeof ValueType];

function encodeU32(value: number): number[] {
  const out: number[] = [];
  let rest = value >>> 0;
  for (;;) {
    const byte = rest & LEB_PAYLOAD;
    rest >>>= LEB_SHIFT;
    if (rest === 0) {
      out.push(byte);
      return out;
    }
    out.push(byte | LEB_CONTINUE);
  }
}
const encodeName = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  return [...encodeU32(bytes.length), ...bytes];
};
const encodeSection = (id: number, content: readonly number[]) => [
  id,
  ...encodeU32(content.length),
  ...content,
];

/** Reads a module's bytes in order; every read checks it stays inside them. */
class Reader {
  at = HEADER_BYTES;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  get done() {
    return this.at >= this.bytes.length;
  }
  byte(): number {
    const value = this.bytes[this.at];
    if (value === undefined) throw new Error("WebAssembly module ends unexpectedly");
    this.at += 1;
    return value;
  }
  u32(): number {
    let result = 0;
    for (let shift = 0; ; shift += LEB_SHIFT) {
      const byte = this.byte();
      result |= (byte & LEB_PAYLOAD) << shift;
      if ((byte & LEB_CONTINUE) === 0) return result >>> 0;
    }
  }
  skip(count: number) {
    this.at += count;
  }
  limits(): number {
    const flags = this.byte();
    const min = this.u32();
    if (flags & LIMITS_HAS_MAX) this.u32();
    return min;
  }
}

/** The minimum size of the function table `bytes` imports. */
export function importedTableMinimum(bytes: Uint8Array): number {
  const reader = new Reader(bytes);
  while (!reader.done) {
    const id = reader.byte();
    const end = reader.u32() + reader.at;
    if (id === SECTION.import)
      for (let count = reader.u32(); count > 0; count--) {
        reader.skip(reader.u32());
        reader.skip(reader.u32());
        const kind = reader.byte();
        if (kind === EXTERNAL.function) reader.u32();
        else if (kind === EXTERNAL.table) {
          reader.byte();
          return reader.limits();
        } else if (kind === EXTERNAL.memory) reader.limits();
        else reader.skip(GLOBAL_DESCRIPTOR_BYTES);
      }
    reader.at = end;
  }
  throw new Error("The WebAssembly module does not import a function table");
}

/** A module whose export `f` calls the JavaScript function it imports as `e.f`. */
export function trampolineModule(params: readonly ValueType[], results: readonly ValueType[]) {
  return new WebAssembly.Module(
    new Uint8Array([
      ...HEADER,
      ...encodeSection(SECTION.type, [
        1,
        FUNCTION_TYPE,
        ...encodeU32(params.length),
        ...params,
        ...encodeU32(results.length),
        ...results,
      ]),
      ...encodeSection(SECTION.import, [
        1,
        ...encodeName("e"),
        ...encodeName("f"),
        EXTERNAL.function,
        0,
      ]),
      ...encodeSection(SECTION.export, [1, ...encodeName("f"), EXTERNAL.function, 0]),
    ]),
  );
}
