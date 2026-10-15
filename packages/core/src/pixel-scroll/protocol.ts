/** Internal experimental wire contract; see docs/PIXEL-SCROLL.md. No runtime hooks. */
import * as z from "zod/mini";

// Unallocated experimental numbers, checked against terminal sources on 2026-10-15.
export const OSC = 19462;
export const MODE = 19463;
export const NS = "luciole-pixel";
export const VERSION = 1;
export const MAX_MESSAGE_LENGTH = 4096;
export const MAX_GRID = 65535;
export const MAX_DELTA = 65535;
const MAX_NONCE_LENGTH = 64;
const MAX_MODIFIERS = 15;
const MAX_BUTTONS = 31;
const MAX_BUTTON = 4;
const BUTTON_BITS = [1, 4, 2, 8, 16];
const PREFIX = `${NS};`;
const INTRODUCER = `\x1b]${OSC};`;
const TERMINATOR = "\x1b\\";

const Version = z.literal(VERSION);
const Generation = z.number().check(z.int(), z.gte(1));
const Id = z.number().check(z.int(), z.gte(1), z.lte(MAX_GRID));
const Origin = z.number().check(z.int(), z.gte(0));
const Cell = z.number().check(z.int(), z.gte(0), z.lt(MAX_GRID));
const Size = z.number().check(z.int(), z.gte(1), z.lte(MAX_GRID));
const Coordinate = z.number().check(z.gte(0), z.lt(MAX_GRID));
const Fraction = z.number().check(z.gte(0), z.lt(1));
// Physical-pixel rounding may reach the following row boundary.
const Phase = z.number().check(z.gte(0), z.lte(1));
const Delta = z.number().check(z.gte(-MAX_DELTA), z.lte(MAX_DELTA));
const Modifiers = z.number().check(z.int(), z.gte(0), z.lte(MAX_MODIFIERS));
const Nonce = z
  .string()
  .check(z.minLength(1), z.maxLength(MAX_NONCE_LENGTH), z.regex(/^[A-Za-z0-9_-]+$/));
const RectSchema = z
  .strictObject({ x: Cell, y: Cell, width: Size, height: Size })
  .check(z.refine((rect) => rect.x + rect.width <= MAX_GRID && rect.y + rect.height <= MAX_GRID));
export type Rect = z.infer<typeof RectSchema>;

const OperationSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("query"), version: Version, nonce: Nonce }),
  z.strictObject({ op: z.literal("begin"), version: Version, generation: Generation }),
  z.strictObject({
    op: z.literal("register"),
    version: Version,
    id: Id,
    generation: Generation,
    rect: RectSchema,
    origin: Origin,
  }),
  z.strictObject({
    op: z.literal("step"),
    version: Version,
    id: Id,
    generation: Generation,
    fraction: Fraction,
  }),
  z.strictObject({ op: z.literal("commit"), version: Version, generation: Generation }),
  z.strictObject({ op: z.literal("release"), version: Version, id: Id, generation: Generation }),
]);
export type PixelOperation = z.infer<typeof OperationSchema>;

const Presented = {
  version: Version,
  id: Id,
  generation: Generation,
  x: Coordinate,
  y: Coordinate,
  phase: Phase,
  modifiers: Modifiers,
};
const ReportSchema = z.discriminatedUnion("op", [
  z
    .strictObject({
      op: z.literal("capability"),
      version: Version,
      nonce: Nonce,
      snapshot: z.boolean(),
      precise: z.boolean(),
      reason: z.enum([
        "ready",
        "reduced-motion",
        "screen-reader",
        "no-gpu",
        "disabled",
        "invalidated",
      ]),
    })
    .check(
      z.refine(
        (report) =>
          report.snapshot === (report.reason === "ready") && report.precise === report.snapshot,
      ),
    ),
  z.strictObject({
    op: z.literal("wheel"),
    ...Presented,
    dx: Delta,
    dy: Delta,
    source: z.enum(["precise", "discrete"]),
  }),
  z
    .strictObject({
      op: z.literal("pointer"),
      ...Presented,
      action: z.enum(["move", "down", "up", "drag"]),
      button: z.number().check(z.int(), z.gte(-1), z.lte(MAX_BUTTON)),
      buttons: z.number().check(z.int(), z.gte(0), z.lte(MAX_BUTTONS)),
    })
    .check(
      z.refine((report) => {
        if (report.action === "move") return report.button === -1 && report.buttons === 0;
        if (report.action === "drag") return report.button === -1 && report.buttons > 0;
        const bit = BUTTON_BITS[report.button];
        if (bit === undefined) return false;
        return report.action === "down"
          ? (report.buttons & bit) !== 0
          : (report.buttons & bit) === 0;
      }),
    ),
]);
export type PixelReport = z.infer<typeof ReportSchema>;
export type PixelMessage = PixelOperation | PixelReport;
const MessageSchema = z.union([OperationSchema, ReportSchema]);

/** Encode one complete OSC with ST. Invalid local data is a programming error. */
export function encode(message: PixelMessage): string {
  const result = MessageSchema.safeParse(message);
  if (!result.success) throw new TypeError("Invalid pixel-scroll message");
  return `${INTRODUCER}${PREFIX}${JSON.stringify(result.data)}${TERMINATOR}`;
}

/** Decode the payload supplied by an OSC parser hook (namespace + JSON, no framing). */
export function decodePayload(payload: unknown): PixelMessage | undefined {
  if (
    typeof payload !== "string" ||
    payload.length > MAX_MESSAGE_LENGTH ||
    !payload.startsWith(PREFIX)
  )
    return undefined;
  // Wire messages are printable ASCII. Escaped control characters still fail schemas.
  if (!/^[\x20-\x7e]+$/.test(payload)) return undefined;
  try {
    const value: unknown = JSON.parse(payload.slice(PREFIX.length));
    const result = MessageSchema.safeParse(value);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/** Decode exactly one complete OSC. Stream reassembly belongs to the ANSI parser. */
export function decode(sequence: unknown): PixelMessage | undefined {
  if (typeof sequence !== "string" || !sequence.startsWith(INTRODUCER)) return undefined;
  const end = sequence.endsWith(TERMINATOR) ? TERMINATOR.length : sequence.endsWith("\x07") ? 1 : 0;
  if (!end) return undefined;
  return decodePayload(sequence.slice(INTRODUCER.length, -end));
}
