import { expect, test } from "bun:test";
import {
  decode,
  decodePayload,
  encode,
  MODE,
  NS,
  OSC,
  VERSION,
  MAX_MESSAGE_LENGTH,
  type PixelMessage,
  type PixelOperation,
  type PixelReport,
} from "../packages/core/src/pixel-scroll/protocol";

const query: PixelOperation = { op: "query", version: 1, nonce: "test_1-A" };
const register: PixelOperation = {
  op: "register",
  version: 1,
  id: 1,
  generation: 7,
  rect: { x: 2, y: 3, width: 80, height: 20 },
  origin: 100,
};
const wheel: PixelReport = {
  op: "wheel",
  version: 1,
  id: 1,
  generation: 7,
  x: 2.25,
  y: 4.75,
  phase: 0.32,
  modifiers: 0,
  dx: -0.125,
  dy: 1.375,
  source: "precise",
};
const pointer: PixelReport = {
  op: "pointer",
  version: 1,
  id: 1,
  generation: 7,
  x: 2.25,
  y: 4.75,
  phase: 0.32,
  modifiers: 15,
  action: "down",
  button: 0,
  buttons: 1,
};
const capability: PixelReport = {
  op: "capability",
  version: 1,
  nonce: query.nonce,
  snapshot: true,
  precise: true,
  reason: "ready",
};
const messages: PixelMessage[] = [
  query,
  capability,
  { op: "begin", version: 1, generation: 7 },
  register,
  { op: "step", version: 1, id: 1, generation: 7, fraction: 0.32 },
  { op: "commit", version: 1, generation: 7 },
  { op: "release", version: 1, id: 1, generation: 7 },
  wheel,
  { ...wheel, dx: 0, dy: -3, source: "discrete" },
  pointer,
  { ...pointer, action: "up", buttons: 0 },
  { ...pointer, action: "move", button: -1, buttons: 0 },
  { ...pointer, action: "drag", button: -1, buttons: 3 },
];
function wire(value: unknown) {
  return `\x1b]19462;luciole-pixel;${JSON.stringify(value)}\x1b\\`;
}

test("pins experimental v1 bytes independently of the encoder", () => {
  expect({ OSC, MODE, NS, VERSION }).toEqual({
    OSC: 19462,
    MODE: 19463,
    NS: "luciole-pixel",
    VERSION: 1,
  });
  expect(encode(query)).toBe(
    '\x1b]19462;luciole-pixel;{"op":"query","version":1,"nonce":"test_1-A"}\x1b\\',
  );
  expect(decode('\x1b]19462;luciole-pixel;{"version":1,"generation":42,"op":"begin"}\x07')).toEqual(
    { version: 1, generation: 42, op: "begin" },
  );
});

for (const [index, message] of messages.entries()) {
  test(`round-trips operation/report ${index}: ${message.op}, including BEL and parser-hook payload`, () => {
    const sequence = encode(message);
    expect(decode(sequence)).toEqual(message);
    expect(decode(sequence.slice(0, -2) + "\x07")).toEqual(message);
    expect(decodePayload(sequence.slice("\x1b]19462;".length, -2))).toEqual(message);
  });
  test(`rejects unknown/missing version and extra fields for message ${index}`, () => {
    for (const version of [undefined, 0, 2, "1", null]) {
      expect(decode(wire({ ...message, version }))).toBeUndefined();
    }
    expect(decode(wire({ ...message, extra: true }))).toBeUndefined();
    for (const key of Object.keys(message)) {
      const missing = Object.fromEntries(Object.entries(message).filter(([name]) => name !== key));
      expect(decode(wire(missing))).toBeUndefined();
    }
  });
}

for (const reason of [
  "reduced-motion",
  "screen-reader",
  "no-gpu",
  "disabled",
  "invalidated",
] as const) {
  test(`round-trips capability refusal/revocation: ${reason}`, () => {
    const refused: PixelReport = { ...capability, snapshot: false, precise: false, reason };
    expect(decode(encode(refused))).toEqual(refused);
  });
}

test("rejects invalid capability pairs and unsafe nonces", () => {
  for (const patch of [
    { snapshot: false },
    { precise: false },
    { reason: "no-gpu" },
    { reason: "unknown" },
    { snapshot: 1 },
    { nonce: "" },
    { nonce: "a".repeat(65) },
    { nonce: "a;b" },
    { nonce: "\x1b\\" },
    { nonce: "é" },
    { nonce: "a\nb" },
  ])
    expect(decode(wire({ ...capability, ...patch }))).toBeUndefined();
});

test("rejects malformed frames, JSON, foreign namespaces and unsupported operations without throwing", () => {
  const valid = encode(query);
  const invalid: unknown[] = [
    undefined,
    null,
    1,
    {},
    [],
    "",
    "hello",
    "\x1b]19462;luciole-pixel;{\x07",
    valid.slice(0, -2),
    valid + "tail",
    "prefix" + valid,
    valid + valid,
    valid.replace("19462", "777"),
    valid.replace("luciole-pixel", "luciole-pixel-v0"),
    valid.replace("\x1b]", "\x9d"),
    valid.slice(0, -2) + "\x9c",
    wire(null),
    wire([]),
    wire(true),
    wire("query"),
    wire({ op: "unknown", version: 1 }),
    valid.replace('{"op"', '{\n"op"'),
    valid.replace("test_1-A", "test\x07_1-A"),
    '\x1b]19462;luciole-pixel;{"op":"step","version":1,"id":1,"generation":1,"fraction":1e999}\x07',
    `\x1b]19462;luciole-pixel;${" ".repeat(MAX_MESSAGE_LENGTH)}{}\x07`,
  ];
  for (const input of invalid) expect(decode(input)).toBeUndefined();
  for (const input of [
    null,
    {},
    "",
    "wrong;{}",
    "luciole-pixel;{",
    "luciole-pixel;" + "[".repeat(MAX_MESSAGE_LENGTH),
  ]) {
    expect(decodePayload(input)).toBeUndefined();
  }
  // A malformed complete message does not poison subsequent calls from the ANSI parser.
  expect(decode(valid)).toEqual(query);
});

test("rejects unsafe generations, ids and content origins", () => {
  for (const generation of [0, -1, 0.5, 9007199254740992, "7", null]) {
    for (const message of messages.filter((value) => "generation" in value)) {
      expect(decode(wire({ ...message, generation }))).toBeUndefined();
    }
  }
  for (const id of [0, -1, 0.5, 65536, "1", null]) {
    for (const message of messages.filter((value) => "id" in value)) {
      expect(decode(wire({ ...message, id }))).toBeUndefined();
    }
  }
  for (const origin of [-1, 0.5, 9007199254740992, "0", null]) {
    expect(decode(wire({ ...register, origin }))).toBeUndefined();
  }
});

test("bounds rectangles including their far edges", () => {
  for (const rect of [
    null,
    [],
    {},
    { ...register.rect, extra: 1 },
    { x: -1, y: 0, width: 1, height: 1 },
    { x: 0, y: -1, width: 1, height: 1 },
    { x: 0.5, y: 0, width: 1, height: 1 },
    { x: 0, y: 0.5, width: 1, height: 1 },
    { x: 0, y: 0, width: 0, height: 1 },
    { x: 0, y: 0, width: 1, height: 0 },
    { x: 0, y: 0, width: 1.5, height: 1 },
    { x: 0, y: 0, width: 1, height: 1.5 },
    { x: 65535, y: 0, width: 1, height: 1 },
    { x: 0, y: 65535, width: 1, height: 1 },
    { x: 1, y: 0, width: 65535, height: 1 },
    { x: 0, y: 1, width: 1, height: 65535 },
  ])
    expect(decode(wire({ ...register, rect }))).toBeUndefined();
});

test("keeps logical fraction half-open and presented quantized phase closed", () => {
  const step: PixelOperation = { op: "step", version: 1, id: 1, generation: 7, fraction: 0 };
  for (const fraction of [-0.001, 1, 1.001, "0", null]) {
    expect(decode(wire({ ...step, fraction }))).toBeUndefined();
  }
  for (const phase of [0, 1])
    expect(decode(encode({ ...wheel, phase }))).toEqual({ ...wheel, phase });
  for (const message of [wheel, pointer]) {
    for (const phase of [-0.001, 1.001, "0", null])
      expect(decode(wire({ ...message, phase }))).toBeUndefined();
    for (const coordinate of [-0.01, 65535, "0", null]) {
      expect(decode(wire({ ...message, x: coordinate }))).toBeUndefined();
      expect(decode(wire({ ...message, y: coordinate }))).toBeUndefined();
    }
    for (const modifiers of [-1, 16, 0.5, "0", null])
      expect(decode(wire({ ...message, modifiers }))).toBeUndefined();
  }
});

test("bounds precise wheel deltas and preserves their sign and source", () => {
  for (const delta of [-65536, 65536, "1", null]) {
    expect(decode(wire({ ...wheel, dx: delta }))).toBeUndefined();
    expect(decode(wire({ ...wheel, dy: delta }))).toBeUndefined();
  }
  expect(decode(wire({ ...wheel, source: "momentum" }))).toBeUndefined();
  expect(decode(encode({ ...wheel, dx: -65535, dy: 65535 }))).toEqual({
    ...wheel,
    dx: -65535,
    dy: 65535,
  });
  for (const value of [NaN, Infinity, -Infinity]) {
    expect(() => encode({ ...wheel, dy: value })).toThrow(TypeError);
  }
});

test("validates pointer actions, DOM button mapping and held-button masks", () => {
  for (const patch of [
    { action: "click" },
    { button: -2 },
    { button: 5 },
    { button: 0.5 },
    { buttons: -1 },
    { buttons: 32 },
    { buttons: 0.5 },
    { buttons: 0 },
    { button: -1 },
    { action: "up", buttons: 1 },
    { action: "move", button: -1, buttons: 1 },
    { action: "move", buttons: 0 },
    { action: "drag", button: -1, buttons: 0 },
  ])
    expect(decode(wire({ ...pointer, ...patch }))).toBeUndefined();
  for (const [button, buttons] of [1, 4, 2, 8, 16].entries()) {
    const down: PixelReport = { ...pointer, button, buttons };
    expect(decode(encode(down))).toEqual(down);
    const up: PixelReport = { ...down, action: "up", buttons: 0 };
    expect(decode(encode(up))).toEqual(up);
  }
});

test("accepts exact integer and geometry limits without truncation", () => {
  const edge: PixelOperation = {
    ...register,
    id: 65535,
    generation: Number.MAX_SAFE_INTEGER,
    origin: Number.MAX_SAFE_INTEGER,
    rect: { x: 65534, y: 65534, width: 1, height: 1 },
  };
  expect(decode(encode(edge))).toEqual(edge);
  const full: PixelOperation = {
    ...register,
    origin: 0,
    rect: { x: 0, y: 0, width: 65535, height: 65535 },
  };
  expect(decode(encode(full))).toEqual(full);
  const step: PixelOperation = {
    op: "step",
    version: 1,
    generation: 1,
    id: 1,
    fraction: 1 - Number.EPSILON,
  };
  expect(decode(encode(step))).toEqual(step);
});
