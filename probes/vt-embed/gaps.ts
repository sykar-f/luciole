// What OpenTUI 0.5.12's EmbeddedTerminalRenderable leaves undone, measured by
// widget-probe.tsx, and the smallest host-side patches. Both belong upstream; they live in
// one module so that removing them is one import.
//
// 1. Keys, legacy keyboard protocol (no kitty flags, i.e. most terminals and every mock):
//    - F1..F12 encode to nothing: physicalKey() returns `key.code` verbatim ("OP",
//      "[15~") or no name at all ("f5" is missing from its table);
//    - Alt+x encodes to nothing: the legacy parser reports ESC-prefixed keys as `meta`,
//      and modifiers() maps `meta` to SUPER, which the libghostty encoder drops;
//    - Backspace encodes to nothing (physical "Backspace", no text): a shell cannot erase.
//    handleKeyPress() below keeps the native encoding whenever it produces bytes (it is
//    mode-aware: DECCKM, kitty flags) and only fills these holes with xterm's sequences.
// 2. Queries: libghostty-vt hands device attributes and color reports to its embedder,
//    and OpenTUI registers no callback: DA1, DA2 and OSC 10/11 stay unanswered (DSR, DECRQM,
//    XTVERSION, kitty `CSI ? u` are answered). Programs that wait for DA1 as a sentinel
//    time out; OpenTUI apps (a luciole Client) fall back to an unknown theme.
import { EmbeddedTerminalRenderable, type KeyEvent } from "@opentui/core";

const ESC = "\x1b";
const DEL = "\x7f";
// Ctrl+letter is the letter's code masked to the C0 range (Ctrl+A = 0x01).
const C0_MASK = 0x1f;
const BS = "\b";
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
  // Alt+printable: ESC prefix, the convention of xterm's metaSendsEscape and every shell.
  // (A one-unit name: legacy parsing only yields Alt+x for single-byte keys.)
  if (alt && key.name.length === 1) {
    const char = key.shift ? key.name.toUpperCase() : key.name;
    return (
      ESC + (key.ctrl ? String.fromCharCode(char.toUpperCase().charCodeAt(0) & C0_MASK) : char)
    );
  }
  return "";
}

/**
 * A RegExp over escape sequences, written with `\e` (ESC) and `\a` (BEL) as in terminfo:
 * the pattern stays readable and free of raw control characters.
 */
export function vtPattern(source: string, flags = "") {
  return new RegExp(source.replaceAll("\\e", ESC).replaceAll("\\a", "\x07"), flags);
}

const encoder = new TextEncoder();
/** The embedded terminal with legacy-key holes filled; everything else is native. */
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

export type Palette = {
  fg: readonly [number, number, number];
  bg: readonly [number, number, number];
};
// Longest query we look for, so a sequence split across two PTY reads is still seen.
const MAX_QUERY_BYTES = 16;
const QUERIES = vtPattern(String.raw`\e\[(>?)0?c|\e\](1[01]);\?(\a|\e\\)`, "g");
const HEX = 16;
const HEX_DIGITS = 2;
const channel = (value: number) => {
  const hex = value.toString(HEX).padStart(HEX_DIGITS, "0");
  return hex + hex; // X11 16-bit form, as xterm answers
};

/**
 * Scans program output for the queries the emulator does not answer and returns the
 * answers. Runs beside the emulator (same bytes, same order), keeping a short tail between
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
