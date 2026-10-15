import { MouseParser, Renderable, type CliRenderer, type KeyEvent } from "@opentui/core";
import { decode, type PixelReport } from "../../pixel-scroll/protocol";
import {
  detectOpenTuiSeams,
  detectScrollableViewport,
  type OpenTuiSeams,
  type RenderFramePlan,
  type RenderHitMap,
  type ScrollableViewport,
} from "../opentui-seams";
import { PixelDiscovery } from "./discovery";
import { pixelHitSource, planPixelFrame, type PixelFrame } from "./frame";
import { PixelHistory } from "./history";

const SHIFT = 1;
const ALT = 2;
const CTRL = 4;
const META = 8;
const SETTLE_DELAY_MS = 120;
const SETTLE_DURATION_MS = 140;
const SETTLE_TICK_MS = 16;
const SETTLE_EASING_POWER = 3;

function ancestorViewport(node: Renderable | null | undefined): ScrollableViewport | undefined {
  for (; node; node = node.parent) {
    const viewport = detectScrollableViewport(node);
    if (viewport) return viewport;
  }
}

function belongsTo(node: Renderable | undefined, owner: Renderable): boolean {
  for (; node; node = node.parent ?? undefined) if (node === owner) return true;
  return false;
}

/** App-side contract v1 controller. Only runInPage attaches it; native is unchanged. */
export class PixelController {
  private readonly discovery = new PixelDiscovery();
  private readonly history = new PixelHistory();
  private readonly mouse = new MouseParser();
  private readonly unsubscribe: () => void;
  private active: ScrollableViewport | undefined;
  private choseInitial = false;
  private next: ScrollableViewport | undefined;
  private last: PixelFrame | undefined;
  private generation = 0;
  private releasing = false;
  private disposed = false;
  private normal: (Uint32Array | Uint16Array)[] = [];
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private settleAnimation: ReturnType<typeof setInterval> | undefined;
  private ids = new WeakMap<ScrollableViewport, number>();
  private id = 0;

  static attach(renderer: CliRenderer, write: (commands: string) => void, settle = false) {
    const found = detectOpenTuiSeams(renderer);
    return found.available ? new PixelController(found.renderer, write, settle) : undefined;
  }

  private readonly renderer: CliRenderer & OpenTuiSeams;
  private readonly write: (commands: string) => void;
  private readonly settle: boolean;

  private constructor(
    renderer: CliRenderer & OpenTuiSeams,
    write: (commands: string) => void,
    settle: boolean,
  ) {
    this.renderer = renderer;
    this.write = write;
    this.settle = settle;
    renderer.setFramePlan(() => this.plan());
    this.unsubscribe = renderer.subscribeOsc((sequence) => this.receive(sequence));
    renderer.keyInput.on("keypress", this.key);
    renderer.on("destroy", this.dispose);
    this.query();
  }

  private query() {
    if (!this.disposed) this.write(`\x1b[?2026h${this.discovery.query()}\x1b[?2026l`);
  }

  private viewports(): ScrollableViewport[] {
    const result: ScrollableViewport[] = [];
    const visit = (node: Renderable) => {
      const viewport = detectScrollableViewport(node);
      if (viewport && viewport.rect.width > 0 && viewport.rect.height > 0) result.push(viewport);
      for (const child of node.getChildren()) visit(child);
    };
    visit(this.renderer.root);
    return result;
  }

  private switchTo(viewport: ScrollableViewport | undefined) {
    if (!viewport) return;
    if (viewport === this.active) {
      // Several wheel reports may arrive before a frame. If their remainder
      // returns to the active ancestor, cancel the not-yet-painted handover.
      if (this.next) {
        this.next = undefined;
        this.releasing = false;
        this.normal = [];
        this.renderer.requestRender();
      }
      return;
    }
    if (viewport === this.next) return;
    this.stopSettle();
    if (this.active && this.last) {
      this.active.set(Math.round(this.active.position));
      this.next = viewport;
      this.releasing = true;
    } else this.active = viewport;
    this.normal = [];
    this.renderer.requestRender();
  }

  /** Observe ordinary reports before stdin consumes them; never consume or rewrite them. */
  ordinary(sequence: string) {
    if (!this.discovery.ready || !sequence.startsWith("\x1b[<")) return;
    const event = this.mouse.parseMouseEvent(Buffer.from(sequence));
    if (!event) return;
    const target = Renderable.renderablesByNumber.get(this.renderer.hitTest(event.x, event.y));
    this.switchTo(ancestorViewport(target));
  }

  private changed(): boolean {
    const buffers = Object.values(this.renderer.nextRenderBuffer.buffers);
    const changed = buffers.some((buffer, index) => {
      const old = this.normal[index];
      return !old || old.length !== buffer.length || buffer.some((value, i) => value !== old[i]);
    });
    if (changed) this.normal = buffers.map((buffer) => buffer.slice());
    return changed;
  }

  private sameHits(a: RenderHitMap | undefined, b: RenderHitMap): boolean {
    if (!a || a.width !== b.width || a.height !== b.height) return false;
    const checked = new Set<number>();
    for (let y = 0; y < b.height; y++) {
      for (let x = 0; x < b.width; x++) {
        const id = b.hitTest(x, y);
        if (a.hitTest(x, y) !== id) return false;
        if (!checked.has(id)) {
          checked.add(id);
          const old = a.origin(id),
            current = b.origin(id);
          if (old?.x !== current?.x || old?.y !== current?.y) return false;
        }
      }
    }
    return true;
  }

  private obscured(viewport: ScrollableViewport, map: RenderHitMap): boolean {
    const { rect, owner } = viewport;
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) {
        const node = Renderable.renderablesByNumber.get(map.hitTest(x, y));
        if (node && !belongsTo(node, owner)) return true;
      }
    }
    return false;
  }

  private plan(): RenderFramePlan | null {
    if (!this.discovery.ready || this.disposed) return null;
    const views = this.viewports();
    if (!this.active && !this.choseInitial) {
      this.active = ancestorViewport(this.renderer.currentFocusedRenderable) ?? views[0];
      this.choseInitial = this.active !== undefined;
    }
    const viewport = this.active;
    if (!viewport) return null;
    const map = this.renderer.captureHitMap();
    const blocked = viewport.owner.isDestroyed || this.obscured(viewport, map);
    if (blocked && !this.last) return null;
    if (blocked) {
      // Layout already painted at the integer origin. A popup must see that same
      // canonical grid in this frame, before any translated snapshot can cover it.
      if (!viewport.owner.isDestroyed) viewport.set(viewport.origin);
      this.releasing = true;
    }
    const { rect } = viewport.owner.isDestroyed && this.last ? this.last : viewport;
    if (rect.width <= 0 || rect.height <= 0) return null;
    const fraction = viewport.position - viewport.origin;
    const contentChanged = this.changed();
    if (
      !this.releasing &&
      this.last &&
      !contentChanged &&
      this.sameHits(this.last.snapshot, map) &&
      this.last.fraction === fraction &&
      this.last.origin === viewport.origin &&
      JSON.stringify(this.last.rect) === JSON.stringify(rect)
    ) {
      return { deferHover: true };
    }
    let id = this.ids.get(viewport);
    if (id === undefined) {
      id = ++this.id;
      this.ids.set(viewport, id);
    }
    const release = this.releasing;
    const frame: PixelFrame = {
      id,
      generation: ++this.generation,
      viewport,
      rect: { ...rect },
      origin: viewport.origin,
      fraction: release ? 0 : fraction,
    };
    const plan = planPixelFrame(frame, release);
    plan.deferHover = true;
    const capture = plan.onHitMap;
    plan.onHitMap = (map) => {
      capture?.(map);
      this.history.add(frame);
      this.last = frame;
      if (release) {
        this.active = this.next;
        this.next = undefined;
        this.last = undefined;
        this.releasing = false;
        this.normal = [];
        if (this.active) this.renderer.requestRender();
      }
    };
    return plan;
  }

  private receive(sequence: string) {
    const capability = this.discovery.receive(sequence);
    if (capability) {
      this.write(this.discovery.mode());
      if (!this.discovery.ready) {
        this.stopSettle();
        if (this.active && !this.active.owner.isDestroyed) this.active.set(this.active.origin);
        this.history.clear();
        this.last = undefined;
        this.normal = [];
        this.renderer.requestRender();
        if (capability.reason === "invalidated") queueMicrotask(() => this.query());
      } else this.renderer.requestRender();
      return;
    }
    if (!this.discovery.ready) return;
    const report = decode(sequence);
    if (report?.op !== "wheel" && report?.op !== "pointer") return;
    const frame = this.history.get(report.id, report.generation);
    if (!frame) return;
    if (
      report.op === "pointer" &&
      report.action === "down" &&
      report.modifiers & (SHIFT | ALT) &&
      frame.fraction > 0
    ) {
      this.stopSettle();
      frame.viewport.set(Math.round(frame.viewport.position));
      this.active = frame.viewport;
      this.releasing = true;
      this.renderer.requestRender();
      return;
    }
    this.dispatch(report, frame);
  }

  private dispatch(report: Extract<PixelReport, { op: "pointer" | "wheel" }>, frame: PixelFrame) {
    const source = pixelHitSource(frame, report.x, report.y, report.phase);
    if (!source.map) return;
    // Resolve the fractional presentation first, then enter OpenTUI's ordinary
    // cell-coordinate selection machine. Fractional bounds select an extra row.
    const x = Math.floor(source.x);
    const y = Math.floor(source.y);
    const modifiers = {
      shift: Boolean(report.modifiers & SHIFT),
      alt: Boolean(report.modifiers & ALT),
      ctrl: Boolean(report.modifiers & CTRL),
      meta: Boolean(report.modifiers & META),
    };
    if (report.op === "wheel") {
      this.stopSettle();
      // Match ordinary Shift+wheel's horizontal policy before setting precise.
      const delta = modifiers.shift ? report.dy : report.dy || report.dx;
      const horizontal = modifiers.shift || (!report.dy && Boolean(report.dx));
      const direction =
        !modifiers.shift && horizontal ? (delta < 0 ? "left" : "right") : delta < 0 ? "up" : "down";
      this.renderer.dispatchMouseEventFromHitMap(
        {
          type: "scroll",
          button: 0,
          x,
          y,
          modifiers,
          scroll: {
            direction,
            delta: Math.abs(delta),
            precise: report.source === "precise" && !horizontal,
          },
        },
        source.map,
      );
      const fractional = this.viewports().find((v) => !Number.isInteger(v.position));
      if (fractional) this.switchTo(fractional);
      if (this.settle) this.settleTimer = setTimeout(() => this.settleRow(), SETTLE_DELAY_MS);
    } else {
      this.renderer.dispatchMouseEventFromHitMap(
        {
          type: report.action,
          button: Math.max(0, report.button),
          x,
          y,
          modifiers,
        },
        source.map,
      );
      if (report.action === "down") {
        const node = Renderable.renderablesByNumber.get(source.map.hitTest(source.x, source.y));
        this.switchTo(ancestorViewport(node));
      }
    }
  }

  private readonly key = (key: KeyEvent) => {
    if (!this.discovery.ready || key.defaultPrevented) return;
    const focused = this.renderer.currentFocusedRenderable;
    const viewport = ancestorViewport(focused);
    if (!viewport) return;
    this.switchTo(viewport);
    // Editors keep their arrows. A focused ScrollBox owns its scroll keys;
    // modified Page keys can scroll its ancestor without stealing text navigation.
    if (focused !== viewport.owner && !(key.ctrl && key.name.startsWith("page"))) return;
    const delta =
      key.name === "down"
        ? 1
        : key.name === "up"
          ? -1
          : key.name === "pagedown"
            ? viewport.rect.height - 1
            : key.name === "pageup"
              ? 1 - viewport.rect.height
              : undefined;
    if (delta === undefined) return;
    this.stopSettle();
    viewport.scroll(delta);
    key.preventDefault();
  };

  private settleRow() {
    const viewport = this.active;
    if (!viewport) return;
    const start = viewport.position;
    const end = Math.round(start);
    const began = performance.now();
    this.settleAnimation = setInterval(() => {
      if (viewport.owner.isDestroyed) return this.stopSettle();
      const t = Math.min(1, (performance.now() - began) / SETTLE_DURATION_MS);
      viewport.set(start + (end - start) * (1 - (1 - t) ** SETTLE_EASING_POWER));
      if (t === 1) this.stopSettle();
    }, SETTLE_TICK_MS);
  }

  private stopSettle() {
    clearTimeout(this.settleTimer);
    clearInterval(this.settleAnimation);
  }

  readonly dispose = () => {
    if (this.disposed) return;
    this.disposed = true;
    this.stopSettle();
    this.unsubscribe();
    this.renderer.keyInput.off("keypress", this.key);
    this.renderer.off("destroy", this.dispose);
    this.renderer.setFramePlan(null);
    this.history.clear();
  };
}
