import {
  VERSION,
  type PixelOperation,
  type PixelReport,
  type Rect,
} from "../../pixel-scroll/protocol";
import type { PixelRenderer, Presentation } from "./presentation";

const HALF_PIXEL = 0.5;

type Pending = {
  generation: number;
  region?: { id: number; rect: Rect; origin: number };
  fraction?: number;
};
type WheelInput = Omit<
  Extract<PixelReport, { op: "wheel" }>,
  "id" | "generation" | "phase" | "version"
>;
type PointerInput = Omit<
  Extract<PixelReport, { op: "pointer" }>,
  "id" | "generation" | "phase" | "version"
>;
type Reason = Extract<PixelReport, { op: "capability" }>["reason"];

/** Parser state is separate from both committed and actually presented metadata. */
export class PixelSession {
  private pending: Pending | undefined;
  private committed: Presentation | undefined;
  presented: Presentation | undefined;
  private highWater = 0;
  private nonce: string | undefined;
  private revoked = new Set<string>();
  private ready = false;
  inputMode = false;

  private readonly renderer: PixelRenderer | undefined;
  private readonly grid: () => { cols: number; rows: number };
  private readonly reason: () => Reason;
  private readonly report: (report: PixelReport) => void;

  constructor(
    renderer: PixelRenderer | undefined,
    grid: () => { cols: number; rows: number },
    reason: () => Reason,
    report: (report: PixelReport) => void,
  ) {
    this.renderer = renderer;
    this.grid = grid;
    this.reason = reason;
    this.report = report;
  }

  input(input: WheelInput | PointerInput): boolean {
    const p = this.presented;
    if (!this.ready || !this.inputMode || !p) return false;
    this.report({ ...input, version: VERSION, id: p.id, generation: p.generation, phase: p.phase });
    return true;
  }

  present(presentation: Presentation | undefined) {
    this.presented = presentation;
  }

  abort() {
    this.pending = undefined;
    this.renderer?.abort();
  }

  invalidate(reason: Reason = "invalidated") {
    this.pending = this.committed = this.presented = undefined;
    this.inputMode = this.ready = false;
    this.renderer?.invalidate();
    if (this.nonce) {
      this.revoked.add(this.nonce);
      this.report({
        op: "capability",
        version: VERSION,
        nonce: this.nonce,
        snapshot: false,
        precise: false,
        reason,
      });
    }
  }

  operation(op: PixelOperation) {
    if (op.op === "query") {
      this.nonce = op.nonce;
      const reason = this.revoked.has(op.nonce) ? "invalidated" : this.reason();
      this.ready = reason === "ready" && this.renderer !== undefined;
      this.report({
        op: "capability",
        version: VERSION,
        nonce: op.nonce,
        snapshot: this.ready,
        precise: this.ready,
        reason: this.ready ? "ready" : reason === "ready" ? "no-gpu" : reason,
      });
      return;
    }
    if (!this.ready || !this.renderer) return;
    if (op.op === "begin") {
      this.abort();
      if (op.generation <= this.highWater) return;
      this.highWater = op.generation;
      this.pending = { generation: op.generation };
      this.renderer.begin();
      return;
    }
    if (op.op === "release") {
      if (this.pending) {
        this.abort();
        return;
      }
      if (
        this.pending ||
        this.committed?.id !== op.id ||
        this.committed.generation !== op.generation ||
        this.committed.fraction !== 0
      )
        return;
      if (this.renderer.release()) this.committed = undefined;
      return;
    }
    const pending = this.pending;
    if (!pending || pending.generation !== op.generation) {
      this.abort();
      return;
    }
    if (op.op === "register") {
      const { cols, rows } = this.grid();
      if (
        pending.region ||
        pending.fraction !== undefined ||
        op.rect.x + op.rect.width > cols ||
        op.rect.y + op.rect.height > rows ||
        (this.committed && this.committed.id !== op.id)
      ) {
        this.abort();
        return;
      }
      this.renderer.capture(op.rect);
      pending.region = { id: op.id, rect: op.rect, origin: op.origin };
      return;
    }
    if (op.op === "step") {
      if (!pending.region || pending.region.id !== op.id || pending.fraction !== undefined) {
        this.abort();
        return;
      }
      pending.fraction = op.fraction;
      return;
    }
    if (!pending.region || pending.fraction === undefined) {
      this.abort();
      return;
    }
    const presentation = {
      ...pending.region,
      generation: pending.generation,
      fraction: pending.fraction,
      phase:
        Math.floor(pending.fraction * this.renderer.cellHeight + HALF_PIXEL) /
        this.renderer.cellHeight,
    };
    this.renderer.commit(presentation);
    this.committed = presentation;
    this.pending = undefined;
  }
}
