import { MouseParser, Renderable, type CliRenderer, type KeyEvent } from "@opentui/core";
import { decode, encode, type PixelReport, type Rect } from "./protocol";
import {
  detectOpenTuiSeams,
  detectScrollableViewport,
  type OpenTuiSeams,
  type RenderFramePlan,
  type RenderHitMap,
  type ScrollableViewport,
} from "../opentui-seams";
import { PixelDiscovery } from "./discovery";
import {
  clipPixelRect,
  painterHitMap,
  pixelHitSource,
  planPixelFrame,
  type PixelFrame,
} from "./frame";
import { PixelHistory } from "./history";
import { OrdinaryPixelInput } from "./ordinary-input";

const SHIFT = 1;
const ALT = 2;
const CTRL = 4;
const META = 8;
const LEFT_HELD = 1;
const MIDDLE_HELD = 4;
const RIGHT_HELD = 2;
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

/** App-side negotiated pixel controller. Attached by web and desktop hosts; plain native terminals keep row scroll. */
export class PixelController {
  private readonly discovery = new PixelDiscovery();
  private readonly history = new PixelHistory();
  private readonly mouse = new MouseParser();
  private readonly unsubscribe: () => void;
  private active: ScrollableViewport | undefined;
  private choseInitial = false;
  private resume: { viewport: ScrollableViewport; fraction: number } | undefined;
  private next: ScrollableViewport | undefined;
  private last: PixelFrame | undefined;
  private wheelRelease: PixelFrame | undefined;
  private readonly ordinaryWheel = new OrdinaryPixelInput();
  private generation = 0;
  private releasing = false;
  private disposed = false;
  private deferredReports: string[] = [];
  private rediscoveryQueued = false;
  private normal: (Uint32Array | Uint16Array)[] = [];
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private settleAnimation: ReturnType<typeof setInterval> | undefined;
  private ids = new WeakMap<ScrollableViewport, number>();
  private id = 0;

  static attach(
    renderer: CliRenderer,
    write: (commands: string) => void,
    { pixelScroll = false, settle = false }: { pixelScroll?: boolean; settle?: boolean } = {},
  ) {
    if (!pixelScroll) return;
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
    this.unsubscribe = renderer.subscribeOsc((sequence) => this.deliverReport(sequence));
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
      if (!node.visible) return;
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
    if (this.disposed || !this.discovery.ready || !sequence.startsWith("\x1b[<")) return;
    const event = this.mouse.parseMouseEvent(Buffer.from(sequence));
    if (!event) return;
    const target = Renderable.renderablesByNumber.get(this.renderer.hitTest(event.x, event.y));
    this.switchTo(ancestorViewport(target));
  }

  private changed(): boolean {
    return this.renderer.nextRenderBuffer.withBuffers(({ char, fg, bg, attributes }) => {
      const planes = [char, fg, bg, attributes];
      const changed = planes.some((buffer, index) => {
        const old = this.normal[index];
        return !old || old.length !== buffer.length || buffer.some((value, i) => value !== old[i]);
      });
      if (changed) this.normal = planes.map((buffer) => buffer.slice());
      return changed;
    });
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

  private visibleRect(viewport: ScrollableViewport) {
    const clips: Rect[] = [
      { x: 0, y: 0, width: this.renderer.width, height: this.renderer.height },
    ];
    for (let node = viewport.owner.parent; node; node = node.parent) {
      if (!node.visible) return;
      const parent = detectScrollableViewport(node);
      if (parent) clips.push(parent.rect);
    }
    return viewport.owner.visible ? clipPixelRect(viewport.rect, clips) : undefined;
  }

  private obscured(viewport: ScrollableViewport, map: RenderHitMap, rect: Rect): boolean {
    const { owner } = viewport;
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
    // Reserve both transactions of a handover before touching change detection.
    // Rendering and input continue; the compositor holds its complete frame.
    const publications = this.wheelRelease && this.wheelRelease.viewport !== this.active ? 2 : 1;
    if (!this.history.canPublish(publications)) return { deferHover: true };
    const views = this.viewports();
    if (!this.active && !this.choseInitial) {
      this.active = ancestorViewport(this.renderer.currentFocusedRenderable) ?? views[0];
      this.choseInitial = this.active !== undefined;
    }
    const viewport = this.active;
    if (!viewport) return null;
    const captured = this.renderer.captureHitMap();
    const visible = this.visibleRect(viewport);
    const map = visible ? painterHitMap(viewport, captured) : captured;
    const blocked = viewport.owner.isDestroyed || !visible || this.obscured(viewport, map, visible);
    if (blocked && !this.last) return null;
    const canonicalRepaint =
      blocked && !viewport.owner.isDestroyed && !Number.isInteger(viewport.position);
    if (blocked) {
      // Layout already painted at the integer origin. A popup must see that same
      // canonical grid in this frame, before any translated snapshot can cover it.
      if (!viewport.owner.isDestroyed) viewport.set(viewport.origin);
      this.releasing = true;
    }
    const rect = visible ?? this.last?.rect;
    if (!rect) return null;
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
    const previous = this.wheelRelease;
    this.wheelRelease = undefined;
    const handoverFrame: PixelFrame | undefined =
      previous && previous.viewport !== viewport
        ? {
            id: previous.id,
            viewport: previous.viewport,
            rect: previous.rect,
            generation: ++this.generation,
            origin: previous.viewport.origin,
            fraction: 0,
          }
        : undefined;
    const handover = handoverFrame ? planPixelFrame(handoverFrame, true) : undefined;
    const release = this.releasing;
    const frame: PixelFrame = {
      id,
      generation: ++this.generation,
      viewport,
      rect: { ...rect },
      origin: viewport.origin,
      fraction: release ? 0 : fraction,
    };
    const plan = planPixelFrame(frame, release, canonicalRepaint);
    if (handover) {
      // Both captures read the same canonical paint. Release the rounded old
      // region before registering the new one, within this synchronized frame.
      const before = plan.before ?? new Uint8Array();
      plan.before = handover.before ?? new Uint8Array();
      plan.after = new Uint8Array([...(handover.after ?? []), ...before, ...(plan.after ?? [])]);
    }
    plan.deferHover = true;
    const capture = plan.onHitMap;
    plan.onHitMap = (map) => {
      capture?.(map);
      handover?.onHitMap?.(map);
      if (handoverFrame) this.history.add(handoverFrame);
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

  private readonly flushReports = () => {
    this.renderer.off("frame:plan:end", this.flushReports);
    const reports = this.deferredReports;
    this.deferredReports = [];
    if (!this.disposed) for (const sequence of reports) this.deliverReport(sequence);
  };

  private deliverReport(sequence: string) {
    try {
      this.receive(sequence);
    } catch (error) {
      console.error("Error in pixel-scroll report:", error);
    }
  }

  private receive(sequence: string) {
    // A 0.6.6 projection can yield while native presentation completes. Keep
    // input in ingress order until geometry is restored, before output can stall.
    if (Reflect.get(this.renderer, "isFramePlanPass") === true) {
      if (this.deferredReports.length === 0) {
        this.renderer.once("frame:plan:end", this.flushReports);
      }
      this.deferredReports.push(sequence);
      return;
    }
    const capability = this.discovery.receive(sequence);
    if (capability) {
      this.history.presentations = this.discovery.presentations;
      this.write(this.discovery.mode());
      if (!this.discovery.ready) {
        this.stopSettle();
        this.active = this.next ?? this.active;
        this.next = undefined;
        this.releasing = false;
        if (capability.reason !== "invalidated") this.resume = undefined;
        if (this.active && !this.active.owner.isDestroyed) {
          this.resume =
            capability.reason === "invalidated"
              ? (this.resume ?? {
                  viewport: this.active,
                  fraction: this.active.position - this.active.origin,
                })
              : undefined;
        }
        for (const viewport of this.viewports()) {
          if (!Number.isInteger(viewport.position)) viewport.set(viewport.origin);
        }
        this.wheelRelease = undefined;
        this.history.clear();
        this.last = undefined;
        this.normal = [];
        this.renderer.requestRender();
        if (capability.reason === "invalidated" && !this.rediscoveryQueued) {
          this.rediscoveryQueued = true;
          queueMicrotask(() => {
            this.rediscoveryQueued = false;
            this.query();
          });
        }
      } else {
        const resume = this.resume;
        this.resume = undefined;
        if (resume && !resume.viewport.owner.isDestroyed)
          resume.viewport.set(resume.viewport.origin + resume.fraction);
        this.renderer.requestRender();
      }
      return;
    }
    if (!this.discovery.ready) return;
    const report = decode(sequence);
    if (report?.op === "presented") {
      if (this.discovery.presentations && this.history.acknowledge(report.id, report.generation))
        this.renderer.requestRender();
      return;
    }
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
      // Release the last emitted region, which may be newer than the one the
      // host still presents. Its canonical grid must include every rounded view.
      this.active = this.last?.viewport ?? this.active ?? frame.viewport;
      this.next = undefined;
      for (const viewport of this.viewports()) viewport.set(Math.round(viewport.position));
      this.releasing = true;
      this.renderer.requestRender();
      return;
    }
    this.dispatch(report, frame);
  }

  private dispatch(report: Extract<PixelReport, { op: "pointer" | "wheel" }>, frame: PixelFrame) {
    const source = pixelHitSource(frame, report.x, report.y, report.phase);
    const map = source.map;
    if (!map) return;
    const id = map.hitTest(source.x, source.y);
    const target = Renderable.renderablesByNumber.get(id);
    if (id && (!target || target.isDestroyed)) return;
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
      const viewport = ancestorViewport(target);
      if (!viewport) {
        // Preserve the row accumulator for wheel listeners outside ScrollBoxes.
        const ordinary = this.ordinaryWheel.convert(encode(report));
        // eslint-disable-next-line no-control-regex -- Split ordinary SGR wheel reports.
        for (const sequence of ordinary.match(/\x1b\[<[^Mm]*[Mm]/g) ?? []) {
          const event = this.mouse.parseMouseEvent(Buffer.from(sequence));
          if (event) this.renderer.dispatchMouseEventFromHitMap(event, map);
        }
        return;
      }
      // Keep the old presented map for this report, but round every other view
      // before precise dispatch. A burst can change targets before any paint.
      this.wheelRelease ??= this.last;
      for (const other of this.viewports())
        if (
          other !== viewport &&
          !belongsTo(viewport.owner, other.owner) &&
          !belongsTo(other.owner, viewport.owner) &&
          !Number.isInteger(other.position)
        )
          other.set(Math.round(other.position));
      this.active = viewport;
      this.next = undefined;
      this.releasing = false;
      this.normal = [];
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
        map,
      );
      const fractional = this.viewports().find((v) => !Number.isInteger(v.position));
      if (fractional) this.active = fractional;
      this.renderer.requestRender();
      if (this.settle) this.settleTimer = setTimeout(() => this.settleRow(), SETTLE_DELAY_MS);
    } else {
      const dispatch = () =>
        this.renderer.dispatchMouseEventFromHitMap(
          {
            type: report.action,
            button:
              report.action === "drag"
                ? report.buttons & LEFT_HELD
                  ? 0
                  : report.buttons & MIDDLE_HELD
                    ? 1
                    : report.buttons & RIGHT_HELD
                      ? 2
                      : report.button
                : Math.max(0, report.button),
            x,
            y,
            modifiers,
          },
          map,
        );
      if (target === frame.viewport.owner && frame.viewport.input)
        frame.viewport.input(frame.origin, dispatch);
      else dispatch();
      if (report.action === "down") {
        this.switchTo(ancestorViewport(target));
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
    const modifiedPage = key.ctrl && key.name.startsWith("page");
    if ((focused !== viewport.owner || viewport.scrollKeys === false) && !modifiedPage) return;
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
    this.deferredReports = [];
    this.renderer.off("frame:plan:end", this.flushReports);
    this.unsubscribe();
    this.renderer.keyInput.off("keypress", this.key);
    this.renderer.off("destroy", this.dispose);
    this.renderer.setFramePlan(null);
    this.history.clear();
  };
}
