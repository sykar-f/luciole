import type { EditorController } from "../editing/controller.ts";
import type { MarkName } from "../model/types.ts";

// Keys to what they mean in the editor, as data: the renderable carries intents out, and
// a test reads the table without a terminal. The application's own bindings run first
// (OpenTUI hands a key to the focused renderable only when no global handler took it).

export type KeyLike = {
  readonly name: string;
  readonly sequence: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly super?: boolean;
};

export type Motion =
  | "left"
  | "right"
  | "up"
  | "down"
  | "lineStart"
  | "lineEnd"
  | "docStart"
  | "docEnd"
  | "pageUp"
  | "pageDown";

export type Intent =
  | { readonly type: "type"; readonly text: string }
  | { readonly type: "enter" }
  | { readonly type: "lineBreak" }
  | { readonly type: "backspace"; readonly word: boolean }
  | { readonly type: "delete"; readonly word: boolean }
  | { readonly type: "move"; readonly to: Motion; readonly word: boolean; readonly extend: boolean }
  | { readonly type: "tab"; readonly back: boolean }
  | { readonly type: "undo" }
  | { readonly type: "redo" }
  | { readonly type: "selectAll" }
  | { readonly type: "copy" }
  | { readonly type: "cut" }
  | { readonly type: "mark"; readonly mark: MarkName };

const ARROWS: Readonly<Record<string, Motion>> = {
  left: "left",
  right: "right",
  up: "up",
  down: "down",
};
const DEL = 127;
const SPACE = 32;

export function intentOf(key: KeyLike): Intent | null {
  const command = key.super === true;
  // Alt arrives as meta in most terminals; both move and delete by word.
  const word = key.meta || (key.ctrl && (key.name === "left" || key.name === "right"));
  const extend = key.shift;
  switch (key.name) {
    case "return":
    case "enter":
      return key.shift || key.meta ? { type: "lineBreak" } : { type: "enter" };
    case "linefeed":
      return { type: "lineBreak" };
    case "backspace":
      return { type: "backspace", word: key.meta || key.ctrl };
    case "delete":
      return { type: "delete", word: key.meta };
    case "tab":
      return { type: "tab", back: key.shift };
    case "home":
      return { type: "move", to: key.ctrl ? "docStart" : "lineStart", word: false, extend };
    case "end":
      return { type: "move", to: key.ctrl ? "docEnd" : "lineEnd", word: false, extend };
    case "pageup":
      return { type: "move", to: "pageUp", word: false, extend };
    case "pagedown":
      return { type: "move", to: "pageDown", word: false, extend };
  }
  const arrow = ARROWS[key.name];
  if (arrow) {
    if (command && (arrow === "left" || arrow === "right"))
      return { type: "move", to: arrow === "left" ? "lineStart" : "lineEnd", word: false, extend };
    if (command)
      return { type: "move", to: arrow === "up" ? "docStart" : "docEnd", word: false, extend };
    return { type: "move", to: arrow, word, extend };
  }
  if (key.ctrl || command) return shortcut(key.name, { shift: key.shift, command });
  // Alt (Option) with a symbol is how some keyboards type it (`[`, `~`, `|` on a French
  // Mac): the symbol is typed. Alt with a letter or a digit is left to shortcuts.
  if (key.meta && !typedWithAlt(key.sequence)) return null;
  if (key.name === "space") return { type: "type", text: " " };
  const code = key.sequence.charCodeAt(0);
  if (!key.sequence || code < SPACE || code === DEL) return null;
  return { type: "type", text: key.sequence };
}

/** A single printable character that is neither a letter nor a digit. */
const typedWithAlt = (sequence: string) => /^[^\p{L}\p{N}\p{Cc}\s]$/u.test(sequence);

/** Ctrl (and Cmd, where the terminal reports it) combinations. */
function shortcut(name: string, options: { shift: boolean; command: boolean }): Intent | null {
  switch (name) {
    case "z":
      return options.shift ? { type: "redo" } : { type: "undo" };
    case "y":
      return { type: "redo" };
    case "a":
      return options.command
        ? { type: "selectAll" }
        : { type: "move", to: "lineStart", word: false, extend: false };
    case "e":
      return { type: "move", to: "lineEnd", word: false, extend: false };
    case "w":
      return { type: "backspace", word: true };
    case "d":
      return { type: "delete", word: false };
    case "c":
      return options.command || options.shift ? { type: "copy" } : null;
    case "x":
      return options.command || options.shift ? { type: "cut" } : null;
    case "b":
      return options.command ? { type: "mark", mark: "bold" } : null;
    case "i":
      return options.command ? { type: "mark", mark: "italic" } : null;
    case "j":
      return { type: "lineBreak" };
    default:
      return null;
  }
}

/**
 * An intent other than a move carried out on `controller` (moves read the screen: the
 * renderable does them). Whether the key was the editor's: an unhandled Tab goes on to the
 * application.
 */
export function perform(
  controller: EditorController,
  intent: Exclude<Intent, { type: "move" }>,
  host: { copy: (markdown: string) => void },
): boolean {
  switch (intent.type) {
    case "type":
      controller.type(intent.text);
      return true;
    case "enter":
      controller.enter();
      return true;
    case "lineBreak":
      controller.lineBreak();
      return true;
    case "backspace":
      if (intent.word) controller.deleteWordBackward();
      else controller.backspace();
      return true;
    case "delete":
      if (intent.word) controller.deleteWordForward();
      else controller.deleteForward();
      return true;
    case "tab": {
      const block = controller.block;
      if (block?.type === "item") {
        controller.indent(intent.back ? -1 : 1);
        return true;
      }
      if (!intent.back && (block?.type === "code" || block?.type === "raw")) {
        controller.type("  ");
        return true;
      }
      return false;
    }
    case "undo":
      controller.undo();
      return true;
    case "redo":
      controller.redo();
      return true;
    case "selectAll":
      controller.selectAll();
      return true;
    case "copy":
    case "cut": {
      const text = intent.type === "cut" ? controller.cut() : controller.selectedMarkdown();
      if (text) host.copy(text);
      return text !== "";
    }
    case "mark":
      controller.toggleMark(intent.mark);
      return true;
  }
}
