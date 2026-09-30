/**
 * An FFI backend for OpenTUI over `opentui.wasm` (docs/WEB.md, W7): it stands in for
 * `@opentui/core/src/platform/ffi.ts` and for bun-ffi-structs' `bun:ffi`, with the same
 * exports, so OpenTUI's call sites are unchanged (plugin.ts substitutes it).
 *
 * Native code and JavaScript no longer share an address space. A pointer is an offset in
 * the module's memory; a JavaScript buffer handed to native code is copied in and, after
 * the call, copied back:
 *
 * - an argument: for the call only;
 * - `ptr(view)` (struct fields, bun-ffi-structs): until the current job ends, copied back
 *   after every native call in between;
 * - `retainPtr(view)` (text native code keeps, `retainedPtrOrNull`): as long as the view
 *   lives, freed by a FinalizationRegistry.
 *
 * A view on the module's memory itself (`typedView`) passes as its offset, without copy.
 */
import { importedTableMinimum, trampolineModule, ValueType } from "./wasm-binary";
import { wasiImports } from "./wasi";

/** An offset in the module's memory; 0 is NULL. */
export type Pointer = number;
export type PointerInput = number | bigint;
type Buffer = ArrayBufferView | ArrayBuffer;
type NativeFunction = (...args: unknown[]) => unknown;

export const FFIType = {
  char: "char",
  int8_t: "int8_t",
  i8: "i8",
  uint8_t: "uint8_t",
  u8: "u8",
  int16_t: "int16_t",
  i16: "i16",
  uint16_t: "uint16_t",
  u16: "u16",
  int32_t: "int32_t",
  i32: "i32",
  int: "int",
  uint32_t: "uint32_t",
  u32: "u32",
  int64_t: "int64_t",
  i64: "i64",
  uint64_t: "uint64_t",
  u64: "u64",
  double: "double",
  f64: "f64",
  float: "float",
  f32: "f32",
  bool: "bool",
  ptr: "ptr",
  pointer: "pointer",
  void: "void",
  cstring: "cstring",
  function: "function",
  usize: "usize",
  callback: "callback",
  napi_env: "napi_env",
  napi_value: "napi_value",
  buffer: "buffer",
} as const;
export type FFIType = (typeof FFIType)[keyof typeof FFIType];
export type FFITypeOrString = FFIType;
export interface FFIFunction {
  readonly args?: readonly FFIType[];
  readonly returns?: FFIType;
  readonly ptr?: Pointer;
  readonly threadsafe?: boolean;
}
export interface FFICallbackInstance {
  readonly ptr: Pointer | null;
  readonly threadsafe: boolean;
  close(): void;
}
export interface Library {
  symbols: Record<string, NativeFunction>;
  createCallback(callback: NativeFunction, definition: FFIFunction): FFICallbackInstance;
  close(): void;
}

export const FFI_UNAVAILABLE = "OpenTUI native FFI is not available for this runtime yet";
export const LIBRARY_CLOSED = "Cannot create FFI callback after library.close() has been called";
export const POINTER_NEGATIVE = "Pointer must be non-negative";
export const POINTER_UNSAFE = "Pointer exceeds safe integer range";
const unavailableInBrowser = (name: string) =>
  `OpenTUI ${name} has no browser backend (audio and the system clipboard are native only)`;

declare global {
  /** What the host sets before OpenTUI loads: opentui.wasm, as a URL or its bytes. */
  var OPENTUI_WASM: unknown;
}

async function wasmBytes(): Promise<Uint8Array> {
  const source = globalThis.OPENTUI_WASM;
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (typeof source === "string" || source instanceof URL) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`opentui.wasm: ${response.status} ${response.statusText}`);
    return new Uint8Array(await response.arrayBuffer());
  }
  throw new Error("Set globalThis.OPENTUI_WASM to opentui.wasm (a URL or its bytes) first");
}

// The table is the host's: wasm-ld gives an exported table a fixed maximum, and every
// callback is a new entry.
const bytes = await wasmBytes();
const table = new WebAssembly.Table({ element: "anyfunc", initial: importedTableMinimum(bytes) });
let memoryOfModule: WebAssembly.Memory | undefined;
const memory = () => {
  if (!memoryOfModule) throw new Error("opentui.wasm is not instantiated yet");
  return memoryOfModule.buffer;
};
const { instance } = await WebAssembly.instantiate(bytes, {
  env: { __indirect_function_table: table },
  wasi_snapshot_preview1: wasiImports(() => memory()),
});
const exportedMemory = instance.exports.memory;
if (!(exportedMemory instanceof WebAssembly.Memory))
  throw new Error("opentui.wasm exports no memory");
memoryOfModule = exportedMemory;

function nativeFunction(name: string): NativeFunction | undefined {
  const value = instance.exports[name];
  if (typeof value !== "function") return undefined;
  return (...args: unknown[]): unknown => Reflect.apply(value, undefined, args);
}
function requiredFunction(name: string): NativeFunction {
  const found = nativeFunction(name);
  if (!found) throw new Error(`opentui.wasm does not export ${name}`);
  return found;
}
const alloc = requiredFunction("opentuiWasmAlloc");
const free = requiredFunction("opentuiWasmFree");
requiredFunction("_initialize")();

const onModuleMemory = (value: Buffer) =>
  (ArrayBuffer.isView(value) ? value.buffer : value) === memory();
const offsetOf = (value: Buffer) => (ArrayBuffer.isView(value) ? value.byteOffset : 0);
const bytesOf = (value: Buffer) =>
  ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
const isBuffer = (value: unknown): value is Buffer =>
  ArrayBuffer.isView(value) || value instanceof ArrayBuffer;

function copyIn(value: Buffer): Pointer {
  const source = bytesOf(value);
  const address = alloc(source.byteLength);
  if (typeof address !== "number" || address === 0) throw new Error("opentui.wasm: out of memory");
  const pointer = address >>> 0;
  new Uint8Array(memory(), pointer, source.byteLength).set(source);
  return pointer;
}
// Native code may have written into the copy: the view sees it, as it would in Bun.
function copyBack(value: Buffer, address: Pointer) {
  const target = bytesOf(value);
  target.set(new Uint8Array(memory(), address, target.byteLength));
}

type Copy = { value: Buffer; address: Pointer };
let transient: Copy[] = [];
let releaseScheduled = false;
function releaseTransient() {
  releaseScheduled = false;
  const copies = transient;
  transient = [];
  for (const copy of copies) free(copy.address);
}

const retained = new WeakMap<ArrayBufferView, Pointer>();
const release = new FinalizationRegistry<Pointer>((address) => free(address));

export function ptr(value: Buffer): Pointer {
  if (onModuleMemory(value)) return offsetOf(value);
  const address = copyIn(value);
  transient.push({ value, address });
  if (!releaseScheduled) {
    releaseScheduled = true;
    queueMicrotask(releaseTransient);
  }
  return address;
}

/** A pointer native code keeps after the call: a copy that lives as long as `value`. */
export function retainPtr(value: ArrayBufferView): Pointer {
  if (onModuleMemory(value)) return value.byteOffset;
  const known = retained.get(value);
  if (known !== undefined) return known;
  const address = copyIn(value);
  retained.set(value, address);
  release.register(value, address);
  return address;
}

/** A copy: an ArrayBuffer cannot alias part of the module's memory. See `typedView`. */
export function toArrayBuffer(pointer: PointerInput, offset: number | undefined, length: number) {
  const start = Number(pointer) + (offset ?? 0);
  return memory().slice(start, start + length);
}

type TypedArrayConstructor<T> = {
  new (buffer: ArrayBuffer, byteOffset: number, length: number): T;
  readonly BYTES_PER_ELEMENT: number;
};
/**
 * A live view on native memory, as Bun's `toArrayBuffer` gives. It detaches when the
 * memory grows (its `length` becomes 0): the caller asks again.
 */
export function typedView<T>(
  Type: TypedArrayConstructor<T>,
  pointer: PointerInput,
  byteLength: number,
): T {
  return new Type(memory(), Number(pointer), byteLength / Type.BYTES_PER_ELEMENT);
}

export const suffix = "wasm";
// Pointers are numbers and output buffers slice as in Bun: zig.ts takes Bun's paths.
export const usesBunFFI = true;

export function toPointer(value: PointerInput): Pointer {
  if (typeof value === "number") return value;
  if (value < 0n) throw new Error(POINTER_NEGATIVE);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(POINTER_UNSAFE);
  return Number(value);
}
export function ffiBool(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}
export function trimNodeFFIOutputBytes(buffer: Uint8Array, length: number): Uint8Array {
  return buffer.subarray(0, length);
}

const U64_BITS = 64;
const I64_TYPES: ReadonlySet<string> = new Set(["i64", "int64_t", "u64", "uint64_t"]);
const POINTER_TYPES: ReadonlySet<string> = new Set([
  "ptr",
  "pointer",
  "buffer",
  "function",
  "callback",
  "cstring",
]);
const valueType = (type: string): ValueType =>
  I64_TYPES.has(type)
    ? ValueType.i64
    : type === "f32" || type === "float"
      ? ValueType.f32
      : type === "f64" || type === "double"
        ? ValueType.f64
        : ValueType.i32;

function toNative(type: string, value: unknown, copies: Copy[]): unknown {
  if (POINTER_TYPES.has(type)) {
    if (value === null || value === undefined) return 0;
    if (typeof value === "number") return value;
    if (typeof value === "bigint") return Number(value);
    if (isBuffer(value)) {
      if (onModuleMemory(value)) return offsetOf(value);
      const address = copyIn(value);
      copies.push({ value, address });
      return address;
    }
    throw new TypeError(`opentui.wasm: a ${type} argument must be a pointer or a buffer`);
  }
  if (I64_TYPES.has(type))
    return typeof value === "bigint" ? value : BigInt(typeof value === "number" ? value : 0);
  if (type === "bool") return value ? 1 : 0;
  return value;
}
function fromNative(type: string | undefined, value: unknown): unknown {
  switch (type) {
    case undefined:
    case "void":
      return undefined;
    case "bool":
      return value !== 0;
    case "ptr":
    case "pointer":
      return value === 0 ? null : typeof value === "number" ? value >>> 0 : value;
    case "u32":
    case "uint32_t":
    case "usize":
      return typeof value === "number" ? value >>> 0 : value;
    case "u64":
    case "uint64_t":
      return typeof value === "bigint" ? BigInt.asUintN(U64_BITS, value) : value;
    default:
      return value;
  }
}

function bind(name: string, definition: FFIFunction): NativeFunction {
  const native = nativeFunction(name);
  if (!native)
    return () => {
      throw new Error(unavailableInBrowser(name));
    };
  const types = definition.args ?? [];
  const returns = definition.returns;
  return (...args: unknown[]) => {
    const copies: Copy[] = [];
    const converted = types.map((type, i) => toNative(type, args[i], copies));
    try {
      return fromNative(returns, native(...converted));
    } finally {
      for (const copy of copies) {
        copyBack(copy.value, copy.address);
        free(copy.address);
      }
      for (const copy of transient) copyBack(copy.value, copy.address);
    }
  };
}

const freeSlots: number[] = [];
function tableEntry(definition: FFIFunction, callback: NativeFunction) {
  const params = (definition.args ?? []).map(valueType);
  const results =
    definition.returns && definition.returns !== "void" ? [valueType(definition.returns)] : [];
  const entry = new WebAssembly.Instance(trampolineModule(params, results), {
    e: { f: callback },
  }).exports.f;
  if (typeof entry !== "function") throw new Error("opentui.wasm: trampoline without export");
  return entry;
}

export function dlopen(_path: string | URL, symbols: Record<string, FFIFunction>): Library {
  const callbacks = new Set<FFICallbackInstance>();
  let closed = false;
  return {
    symbols: Object.fromEntries(
      Object.entries(symbols).map(([name, definition]) => [name, bind(name, definition)]),
    ),
    createCallback(callback, definition) {
      if (closed) throw new Error(LIBRARY_CLOSED);
      const types = definition.args ?? [];
      const returns = definition.returns ?? "void";
      // Arguments arrive as native values (pointers are offsets, u32 are signed): each is
      // read as a result of that type; the result goes back as an argument would.
      const adapted = (...args: unknown[]) => {
        const result = callback(...args.map((value, i) => fromNative(types[i], value)));
        return returns === "void" ? undefined : toNative(returns, result, []);
      };
      const slot = freeSlots.pop() ?? table.grow(1);
      table.set(slot, tableEntry(definition, adapted));
      let slotPointer: Pointer | null = slot;
      const instance: FFICallbackInstance = {
        get ptr() {
          return slotPointer;
        },
        threadsafe: false,
        close() {
          if (slotPointer === null) return;
          table.set(slot, null);
          freeSlots.push(slot);
          slotPointer = null;
          callbacks.delete(instance);
        },
      };
      callbacks.add(instance);
      return instance;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const callback of callbacks) callback.close();
    },
  };
}
