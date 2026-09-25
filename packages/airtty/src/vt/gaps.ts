/**
 * What OpenTUI 0.5.12's EmbeddedTerminalRenderable leaves undone, and the smallest
 * host-side patches (measured in probes/vt-embed). Both belong upstream: they live in
 * this one module so that removing them, once OpenTUI fixes them, is one import.
 *
 * 1. Keys, legacy keyboard protocol (no kitty flags: most terminals and every mock).
 *    F1–F12 encode to nothing (the native table misses them), Alt+x encodes to nothing
 *    (the legacy parser reports ESC-prefixed keys as `meta`, mapped to SUPER, which the
 *    encoder drops), and Backspace encodes to nothing (a shell cannot erase).
 *    `VtTerminalRenderable` keeps the native, mode-aware encoding (DECCKM, kitty flags)
 *    whenever it produces bytes and only fills these holes with xterm's sequences.
 * 2. Queries. libghostty-vt hands device attributes and color reports to its embedder,
 *    and OpenTUI registers no callback: DA1, DA2 and OSC 10/11 stay unanswered (DSR,
 *    DECRQM, XTVERSION are answered natively). Programs that wait for DA1 as a sentinel
 *    time out; an OpenTUI program (an airtty Client) falls back to an unknown theme.
 */
import { EmbeddedTerminalRenderable, type KeyEvent } from "@opentui/core";

const ESC = "\x1b";
const BEL = "\x07";
const DEL = "\x7f";
const BS = "\b";
// Ctrl+letter is the letter's code masked to the C0 range (Ctrl+A = 0x01).
const C0_MASK = 0x1f;
// xterm modifier parameter: 1 + shift(1) + alt(2) + ctrl(4).
const SHIFT_BIT = 1;
const ALT_BIT = 2;
const CTRL_BIT = 4;
const SS3_KEYS: Record<string, string> = { f1: "P", f2: "Q", f3: "R", f4: "S" };
const TILDE_KEYS: Record<string, number> = {
  f5: 15,
  f6: 17,
  f7: 18,
  f8: 19,
  f9: 20,
  f10: 21,
  f11: 23,
  f12: 24,
};

/** xterm's encoding of the keys the native encoder skips; "" when it has nothing to add. */
export function legacyKey(key: KeyEvent): string {
  const alt = key.meta || key.option;
  const mods = (key.shift ? SHIFT_BIT : 0) | (alt ? ALT_BIT : 0) | (key.ctrl ? CTRL_BIT : 0);
  const ss3 = SS3_KEYS[key.name];
  if (ss3) return mods ? `${ESC}[1;${mods + 1}${ss3}` : `${ESC}O${ss3}`;
  const tilde = TILDE_KEYS[key.name];
  if (tilde !== undefined) return mods ? `${ESC}[${tilde};${mods + 1}~` : `${ESC}[${tilde}~`;
  if (key.name === "backspace") return (alt ? ESC : "") + (key.ctrl ? BS : DEL);
  // Alt+printable: an ESC prefix, xterm's metaSendsEscape and every shell's convention.
  // Legacy parsing only yields Alt+x for single-byte keys.
  if (alt && key.name.length === 1) {
    const char = key.shift ? key.name.toUpperCase() : key.name;
    return (
      ESC + (key.ctrl ? String.fromCharCode(char.toUpperCase().charCodeAt(0) & C0_MASK) : char)
    );
  }
  return "";
}

const encoder = new TextEncoder();
/** The embedded terminal with the legacy-key holes filled; everything else is native. */
export class VtTerminalRenderable extends EmbeddedTerminalRenderable {
  override handleKeyPress(key: KeyEvent): boolean {
    const native = this.encodeKey(key);
    // Releases reach this method too (kitty "report events"): never invent bytes for them.
    const bytes =
      native.byteLength > 0 || key.eventType === "release"
        ? native
        : encoder.encode(legacyKey(key));
    if (bytes.byteLength === 0) return false;
    this.onData?.(bytes, "input");
    return true;
  }
}

/** RGB channels, 0–255. */
export type Rgb = readonly [number, number, number];
export type Palette = { fg: Rgb; bg: Rgb };
// Longest query looked for, so that one split across two PTY reads is still seen.
const MAX_QUERY_BYTES = 16;
const QUERIES = new RegExp(
  String.raw`\e\[(>?)0?c|\e\](1[01]);\?(\a|\e\\)`.replaceAll("\\e", ESC).replaceAll("\\a", BEL),
  "g",
);
const HEX = 16;
const HEX_DIGITS = 2;
// X11's 16-bit form, as xterm answers.
const channel = (value: number) => value.toString(HEX).padStart(HEX_DIGITS, "0").repeat(2);

/**
 * Scans program output for the queries the emulator leaves unanswered and returns the
 * answers. Runs beside the emulator on the same bytes, keeping a short tail between
 * chunks. DA1 claims a VT220 with ANSI color, like Ghostty and xterm.
 */
export function queryResponder(palette: Palette) {
  let carry = "";
  return (bytes: Uint8Array): string => {
    const input = carry + Buffer.from(bytes).toString("latin1");
    let answers = "";
    let end = 0;
    for (const match of input.matchAll(QUERIES)) {
      end = match.index + match[0].length;
      if (match[2]) {
        const [r, g, b] = match[2] === "10" ? palette.fg : palette.bg;
        answers += `${ESC}]${match[2]};rgb:${channel(r)}/${channel(g)}/${channel(b)}${match[3]}`;
      } else answers += match[1] ? `${ESC}[>1;10;0c` : `${ESC}[?62;22c`;
    }
    const rest = input.slice(end);
    const open = rest.lastIndexOf(ESC);
    carry = open >= 0 && rest.length - open < MAX_QUERY_BYTES ? rest.slice(open) : "";
    return answers;
  };
}
