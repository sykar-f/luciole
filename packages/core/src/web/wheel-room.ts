/**
 * Whether a turn of the wheel over a cell still scrolls something in the application, each
 * way: what a browser knows of its own nested scrollers, read from what the renderer shows.
 * The embedding page passes the wheel on to itself only where the application has nothing
 * left to scroll (docs/WEB.md, "Page embarquée", `lucioleScrollRoom`).
 *
 * The walk is OpenTUI's own for a `scroll` event (renderer.ts, processSingleMouseEvent):
 * the renderable under the cell, else the focused one, then each of its parents in turn,
 * every one of which gets the event. Its scrollers say how far they are from their ends;
 * a renderable that scrolls by itself says so with `wheelRoom()` and keeps the event; one
 * that listens to the wheel without saying (an `onMouseScroll` that pans a canvas, a
 * terminal inside the application) may do anything with it: the application keeps it.
 */
import {
  EditBufferRenderable,
  EmbeddedTerminalRenderable,
  Renderable,
  ScrollBoxRenderable,
  TextBufferRenderable,
  type CliRenderer,
} from "@opentui/core";

export type Room = { up: boolean; down: boolean };

const NONE: Room = { up: false, down: false };
const ALL: Room = { up: true, down: true };

/** What a scroller of OpenTUI has left each way; undefined for anything else. */
function scrollerRoom(node: Renderable): Room | undefined {
  if (node instanceof ScrollBoxRenderable) {
    const max = Math.max(0, node.scrollHeight - node.viewport.height);
    return { up: node.scrollTop > 0, down: node.scrollTop < max };
  }
  if (node instanceof TextBufferRenderable)
    return { up: node.scrollY > 0, down: node.scrollY < node.maxScrollY };
  if (node instanceof EditBufferRenderable) {
    const { offsetY, height } = node.editorView.getViewport();
    const max = Math.max(0, node.editorView.getTotalVirtualLineCount() - height);
    return { up: offsetY > 0, down: offsetY < max };
  }
  return undefined;
}

/** A renderable's own answer (`wheelRoom()`), as the editor of `@luciole-sh/markdown-editor` gives it. */
function ownRoom(node: Renderable): Room | undefined {
  const own: unknown = Reflect.get(node, "wheelRoom");
  if (typeof own !== "function") return undefined;
  const room: unknown = Reflect.apply(own, node, []);
  if (typeof room !== "object" || room === null) return undefined;
  return { up: Reflect.get(room, "up") === true, down: Reflect.get(room, "down") === true };
}

/** Listens to the wheel itself (`onMouseScroll`, `onMouse`): what it does with it is its own. */
function listens(node: Renderable) {
  if (node instanceof EmbeddedTerminalRenderable) return true;
  if (typeof Reflect.get(node, "_mouseListener") === "function") return true;
  const listeners: unknown = Reflect.get(node, "_mouseListeners");
  return (
    typeof listeners === "object" &&
    listeners !== null &&
    typeof Reflect.get(listeners, "scroll") === "function"
  );
}

/** The room the wheel has over the cell (x, y), 0-based, as the renderer last drew it. */
export function wheelRoom(renderer: CliRenderer, x: number, y: number): Room {
  if (renderer.isDestroyed) return NONE;
  const focused = renderer.currentFocusedRenderable;
  let node: Renderable | null | undefined =
    Renderable.renderablesByNumber.get(renderer.hitTest(x, y)) ??
    (focused && !focused.isDestroyed && focused.focused ? focused : null);
  let up = false;
  let down = false;
  for (; node; node = node.parent) {
    const own = ownRoom(node);
    if (own) return { up: up || own.up, down: down || own.down };
    const room = scrollerRoom(node);
    if (room) {
      up ||= room.up;
      down ||= room.down;
    } else if (listens(node)) return ALL;
  }
  return { up, down };
}
