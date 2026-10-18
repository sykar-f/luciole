/**
 * Legacy-key fallback for EmbeddedTerminalRenderable. OpenTUI 0.6.6 encodes
 * Alt/meta and function keys natively and answers device/color queries itself.
 * Keep the fallback for a key only when the native encoder returns no bytes.
 */
import { EmbeddedTerminalRenderable, type KeyEvent } from "@opentui/core";

const ESC = "\x1b";
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
