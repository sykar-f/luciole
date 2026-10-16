import type { ITerminalAddon, Terminal, IDisposable } from "@xterm/xterm";
import {
  decodePayload,
  encode,
  MAX_DELTA,
  MODE,
  NS,
  OSC,
  VERSION,
  type PixelReport,
} from "../../pixel-scroll/protocol";
import type { PixelRenderer } from "./presentation";
import { PixelSession } from "./session";

const SHIFT = 1;
const ALT = 2;
const CTRL = 4;
const META = 8;
const LINE = 1;
const PAGE = 2;
const MAX_BUTTONS = 31;
const LAST_BUTTON = 4;
const modifiers = (event: MouseEvent) =>
  (event.shiftKey ? SHIFT : 0) |
  (event.altKey ? ALT : 0) |
  (event.ctrlKey ? CTRL : 0) |
  (event.metaKey ? META : 0);

// Mirror xterm.js 6.0.0 SelectionService.shouldForceSelection and common/Platform.isMac.
function shouldForceSelection(event: MouseEvent, macOptionClickForcesSelection: boolean) {
  return ["Macintosh", "MacIntel", "MacPPC", "Mac68K"].includes(navigator.platform)
    ? event.altKey && macOptionClickForcesSelection
    : event.shiftKey;
}

type Held = { type: string; init: MouseEventInit };

/** In-band host addon. The ordinary custom wheel handler remains the fallback. */
export class PixelScrollAddon implements ITerminalAddon {
  private readonly disposables: IDisposable[] = [];
  private session: PixelSession | undefined;
  private terminal: Terminal | undefined;
  private synchronized = false;
  private held: Held[] | undefined;
  private replaying = false;
  private dragging = false;
  private lost = false;

  private readonly renderer: PixelRenderer | undefined;

  constructor(renderer: PixelRenderer | undefined) {
    this.renderer = renderer;
  }

  activate(terminal: Terminal) {
    this.terminal = terminal;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const session = (this.session = new PixelSession(
      this.renderer,
      () => ({ cols: terminal.cols, rows: terminal.rows }),
      () =>
        motion.matches
          ? "reduced-motion"
          : terminal.options.screenReaderMode
            ? "screen-reader"
            : this.lost || !this.renderer || this.renderer.cellHeight <= 0
              ? "no-gpu"
              : "ready",
      (report) => terminal.input(encode(report), false),
    ));
    const invalidate = () => this.invalidate(motion.matches ? "reduced-motion" : "invalidated");
    motion.addEventListener("change", invalidate);
    this.disposables.push({ dispose: () => motion.removeEventListener("change", invalidate) });
    if (this.renderer)
      this.disposables.push(
        this.renderer.onInvalidate(() =>
          this.invalidate(terminal.options.screenReaderMode ? "screen-reader" : "invalidated"),
        ),
      );
    if (this.renderer)
      this.disposables.push(
        this.renderer.onPresent((presentation) => {
          session.present(presentation);
          if (!presentation) this.replay();
        }),
      );
    this.disposables.push(terminal.onResize(() => this.invalidate()));
    this.disposables.push(terminal.buffer.onBufferChange(() => this.invalidate()));
    this.disposables.push(
      terminal.parser.registerEscHandler({ final: "c" }, () => {
        this.invalidate();
        return false;
      }),
    );
    this.disposables.push(
      terminal.parser.registerOscHandler(OSC, (payload) => {
        if (!this.synchronized) return true;
        const message = decodePayload(payload);
        if (
          message &&
          message.op !== "capability" &&
          message.op !== "wheel" &&
          message.op !== "pointer"
        ) {
          try {
            session.operation(message);
          } catch {
            this.invalidate("no-gpu");
          }
        } else if (!message && payload.startsWith(`${NS};`)) {
          // Unknown versions do not participate in this version's transaction.
          try {
            const raw: unknown = JSON.parse(payload.slice(NS.length + 1));
            if (
              typeof raw === "object" &&
              raw !== null &&
              "version" in raw &&
              raw.version === VERSION
            )
              session.abort();
          } catch {
            session.abort();
          }
        }
        return true;
      }),
    );
    for (const final of ["h", "l"]) {
      this.disposables.push(
        terminal.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
          if (params.includes(MODE)) session.inputMode = final === "h";
          const SYNC = 2026;
          if (params.includes(SYNC)) this.synchronized = final === "h";
          // Let xterm handle synchronized output and any other modes in the same CSI.
          return false;
        }),
      );
    }
    const element = terminal.element;
    if (element) {
      for (const type of ["mousedown", "mousemove", "mouseup"] as const) {
        const listener = (event: MouseEvent) => this.pointer(event);
        element.ownerDocument.addEventListener(type, listener, true);
        this.disposables.push({
          dispose: () => element.ownerDocument.removeEventListener(type, listener, true),
        });
      }
      const canvas = element.querySelector(".xterm-webgl-layer");
      const loss = () => {
        this.lost = true;
        this.invalidate("no-gpu");
      };
      canvas?.addEventListener("webglcontextlost", loss);
      this.disposables.push({
        dispose: () => canvas?.removeEventListener("webglcontextlost", loss),
      });
    }
  }

  invalidate(
    reason: "no-gpu" | "invalidated" | "reduced-motion" | "screen-reader" = "invalidated",
  ) {
    if (this.lost) reason = "no-gpu";
    else if (this.terminal?.options.screenReaderMode && reason !== "reduced-motion")
      reason = "screen-reader";
    this.held = undefined;
    this.dragging = false;
    this.synchronized = false;
    this.session?.invalidate(reason);
  }

  private point(event: MouseEvent) {
    const terminal = this.terminal;
    const box = terminal?.element?.querySelector(".xterm-screen")?.getBoundingClientRect();
    const session = this.session;
    const p = session?.presented;
    if (!terminal || !box?.width || !box.height || !session?.inputMode || !p) return undefined;
    const x = ((event.clientX - box.left) * terminal.cols) / box.width;
    const y = ((event.clientY - box.top) * terminal.rows) / box.height;
    if (x < 0 || y < 0 || x >= terminal.cols || y >= terminal.rows) return undefined;
    const inside =
      x >= p.rect.x && x < p.rect.x + p.rect.width && y >= p.rect.y && y < p.rect.y + p.rect.height;
    return {
      x,
      y,
      inside,
      p,
      cellWidth: box.width / terminal.cols,
      cellHeight: box.height / terminal.rows,
    };
  }

  /** true means the existing wheel path should handle this event. */
  wheel(event: WheelEvent): boolean {
    const point = this.point(event);
    if (!point || (!point.inside && event.deltaMode !== 0)) return true;
    let dx = event.deltaX;
    let dy = event.deltaY;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return true;
    if (event.deltaMode === PAGE) {
      dx *= this.terminal?.cols ?? 1;
      dy *= this.terminal?.rows ?? 1;
    } else if (event.deltaMode !== LINE) {
      dx /= point.cellWidth;
      dy /= point.cellHeight;
    }
    event.preventDefault();
    const count = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / MAX_DELTA));
    for (let i = 0; i < count; i++)
      this.report({
        op: "wheel",
        version: VERSION,
        id: point.p.id,
        generation: point.p.generation,
        phase: point.p.phase,
        x: point.x,
        y: point.y,
        modifiers: modifiers(event),
        dx: dx / count,
        dy: dy / count,
        source: event.deltaMode === LINE || event.deltaMode === PAGE ? "discrete" : "precise",
      });
    return false;
  }

  private remember(event: MouseEvent) {
    return {
      type: event.type,
      init: {
        bubbles: true,
        cancelable: true,
        clientX: event.clientX,
        clientY: event.clientY,
        button: event.button,
        buttons: event.buttons,
        detail: event.detail,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
      },
    };
  }

  private pointer(event: MouseEvent) {
    if (this.replaying) return;
    const element = this.terminal?.element;
    if (
      !this.held &&
      !this.dragging &&
      (!(event.target instanceof Node) || !element?.contains(event.target))
    )
      return;
    if (this.held) {
      this.held.push(this.remember(event));
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (event.buttons < 0 || event.buttons > MAX_BUTTONS) return;
    const wasDragging = this.dragging;
    if (event.type === "mouseup" && !event.buttons) this.dragging = false;
    const point = this.point(event);
    if (event.type === "mousedown")
      console.debug(
        "[DEBUG-editor-press-host]",
        JSON.stringify({
          point,
          inputMode: this.session?.inputMode,
          presented: this.session?.presented,
          wasDragging,
        }),
      );
    if (!point || (!point.inside && !wasDragging)) return;
    // On a canonical grid, leave the terminal's native selection gesture intact.
    const native = shouldForceSelection(
      event,
      this.terminal?.options.macOptionClickForcesSelection === true,
    );
    if (native && point.p.fraction === 0) return;
    if (event.type === "mousedown" && (event.button < 0 || event.button > LAST_BUTTON)) return;
    if (event.type === "mouseup" && (event.button < 0 || event.button > LAST_BUTTON)) return;
    const action =
      event.type === "mousedown"
        ? "down"
        : event.type === "mouseup"
          ? "up"
          : event.buttons
            ? "drag"
            : "move";
    if (action === "down") this.dragging = true;
    if (action === "up" && !event.buttons) this.dragging = false;
    if (native && point.p.fraction > 0 && action === "down") this.held = [this.remember(event)];
    event.preventDefault();
    event.stopImmediatePropagation();
    this.report({
      op: "pointer",
      version: VERSION,
      id: point.p.id,
      generation: point.p.generation,
      phase: point.p.phase,
      x: point.x,
      y: point.y,
      modifiers: modifiers(event),
      action,
      button: action === "move" || action === "drag" ? -1 : event.button,
      buttons: event.buttons,
    });
  }

  private replay() {
    const held = this.held;
    this.held = undefined;
    this.dragging = false;
    const target = this.terminal?.element?.querySelector(".xterm-screen");
    if (!held || !target) return;
    this.replaying = true;
    try {
      for (const event of held) target.dispatchEvent(new MouseEvent(event.type, event.init));
    } finally {
      this.replaying = false;
    }
  }

  private report(report: PixelReport) {
    if (report.op === "wheel" || report.op === "pointer") this.session?.input(report);
  }

  dispose() {
    this.held = undefined;
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.renderer?.invalidate();
    this.session = undefined;
    this.terminal = undefined;
  }
}
