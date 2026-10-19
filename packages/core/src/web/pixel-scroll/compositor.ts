import type { Rect } from "../../pixel-scroll/protocol";
import type { PixelRenderer, Presentation } from "../../pixel-scroll/presentation";

const HALF_PIXEL = 0.5;

type Target = {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
};
type Cursor = { image: Target; x: number; y: number };
type Frame = {
  image: Target;
  snapshot: Target;
  presentation: Presentation;
  canonical: string;
  cursor: Cursor | undefined;
};
type Metrics = {
  canvas: { width: number; height: number };
  cell: { width: number; height: number };
};

/** GPU resources stay in the renderer's context. Entire validated frames are retained:
 * an expired synchronized-output envelope must not expose uncommitted chrome either. */
export class PixelCompositor implements PixelRenderer {
  private pending: Target | undefined;
  private active: Frame | undefined;
  private ready: Frame | undefined;
  private held: Target | undefined;
  private preparing = false;
  private releasing = false;
  private scratch: Target | undefined;
  private readonly invalidations = new Set<() => void>();
  private readonly listeners = new Set<
    (presentation: Presentation | undefined, released?: Presentation) => void
  >();

  private readonly gl: WebGL2RenderingContext;
  private readonly metrics: () => Metrics;
  private readonly rasterize: (cursor: boolean) => void;
  private readonly cursorRect: () => Rect | undefined;
  private readonly cursorVisible: () => boolean;
  private readonly signature: () => string;
  private readonly refresh: () => void;

  constructor(
    gl: WebGL2RenderingContext,
    metrics: () => Metrics,
    rasterize: (cursor: boolean) => void,
    cursorRect: () => Rect | undefined,
    cursorVisible: () => boolean,
    signature: () => string,
    refresh: () => void,
  ) {
    this.gl = gl;
    this.metrics = metrics;
    this.rasterize = rasterize;
    this.cursorRect = cursorRect;
    this.cursorVisible = cursorVisible;
    this.signature = signature;
    this.refresh = refresh;
  }

  changed() {
    this.invalidate();
    for (const listener of this.invalidations) listener();
  }

  onInvalidate(listener: () => void) {
    this.invalidations.add(listener);
    return {
      dispose: () => {
        this.invalidations.delete(listener);
      },
    };
  }

  get cellHeight() {
    return this.metrics().cell.height;
  }

  onPresent(listener: (presentation: Presentation | undefined, released?: Presentation) => void) {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  private remove(target: Target | undefined) {
    if (!target) return;
    this.gl.deleteTexture(target.texture);
    this.gl.deleteFramebuffer(target.framebuffer);
  }

  private removeFrame(frame: Frame | undefined) {
    if (!frame) return;
    this.remove(frame.image);
    this.remove(frame.snapshot);
    this.remove(frame.cursor?.image);
  }

  private target(width: number, height: number): Target {
    const gl = this.gl;
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) {
      gl.deleteTexture(texture);
      gl.deleteFramebuffer(framebuffer);
      throw new Error("Pixel-scroll allocation failed");
    }
    const previous: unknown = gl.getParameter(gl.TEXTURE_BINDING_2D);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, previous instanceof WebGLTexture ? previous : null);
    if (!complete) {
      this.remove({ texture, framebuffer, width, height });
      throw new Error("Pixel-scroll framebuffer incomplete");
    }
    return { texture, framebuffer, width, height };
  }

  private blit(
    from: Target | undefined,
    to: Target | undefined,
    sx: number,
    sy: number,
    width: number,
    height: number,
    dx = 0,
    dy = 0,
  ) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from?.framebuffer ?? null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, to?.framebuffer ?? null);
    gl.blitFramebuffer(
      sx,
      sy,
      sx + width,
      sy + height,
      dx,
      dy,
      dx + width,
      dy + height,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private pixels(rect: Rect) {
    const d = this.metrics();
    return {
      x: rect.x * d.cell.width,
      y: d.canvas.height - (rect.y + rect.height) * d.cell.height,
      width: rect.width * d.cell.width,
      height: rect.height * d.cell.height,
    };
  }

  private raster(cursor = false): Target {
    const d = this.metrics().canvas;
    if (!this.scratch || this.scratch.width !== d.width || this.scratch.height !== d.height) {
      this.remove(this.scratch);
      this.scratch = this.target(d.width, d.height);
    }
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.scratch.framebuffer);
    try {
      this.rasterize(cursor);
    } finally {
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    }
    return this.scratch;
  }

  private copy(source: Target): Target {
    const target = this.target(source.width, source.height);
    this.blit(source, target, 0, 0, source.width, source.height);
    return target;
  }

  begin() {
    this.abort();
    if (!this.active && !this.ready && !this.held) this.held = this.copy(this.raster(true));
    this.preparing = true;
    this.releasing = false;
  }

  capture(rect: Rect) {
    const p = this.pixels(rect);
    const source = this.raster();
    this.remove(this.pending);
    this.pending = this.target(p.width, p.height);
    this.blit(source, this.pending, p.x, p.y, p.width, p.height);
  }

  private captureCursor(): Cursor | undefined {
    const rect = this.cursorRect();
    if (!rect) return undefined;
    const p = this.pixels(rect);
    const source = this.raster(true);
    const image = this.target(p.width, p.height);
    this.blit(source, image, p.x, p.y, p.width, p.height);
    return { image, x: p.x, y: p.y };
  }

  private draw(frame: Frame) {
    this.blit(frame.image, undefined, 0, 0, frame.image.width, frame.image.height);
    const cursor = frame.cursor;
    if (cursor && this.cursorVisible())
      this.blit(
        cursor.image,
        undefined,
        0,
        0,
        cursor.image.width,
        cursor.image.height,
        cursor.x,
        cursor.y,
      );
  }

  commit(presentation: Presentation) {
    if (!this.pending) throw new Error("Missing checkpoint");
    const image = this.copy(this.raster());
    const p = this.pixels(presentation.rect);
    const offset = Math.floor(presentation.fraction * this.cellHeight + HALF_PIXEL);
    // Preserve the entering edge from this exact commit, including offset=H.
    // In GL's bottom-up coordinates its source starts at H-offset in the last row.
    if (offset)
      this.blit(
        this.scratch,
        image,
        p.x,
        p.y + this.cellHeight - offset,
        p.width,
        offset,
        p.x,
        p.y,
      );
    // A positive fraction rounded to zero still replaces the future grid.
    if (offset < p.height)
      this.blit(this.pending, image, 0, 0, p.width, p.height - offset, p.x, p.y + offset);
    this.removeFrame(this.ready);
    this.ready = {
      image,
      snapshot: this.pending,
      presentation,
      canonical: this.signature(),
      cursor: this.captureCursor(),
    };
    this.pending = undefined;
    this.preparing = false;
    this.refresh();
  }

  release() {
    const frame = this.ready ?? this.active;
    if (
      this.preparing ||
      !frame ||
      frame.presentation.fraction !== 0 ||
      frame.canonical !== this.signature()
    )
      return false;
    this.releasing = true;
    this.refresh();
    return true;
  }

  abort() {
    this.remove(this.pending);
    this.pending = undefined;
    // Stay frozen until another complete transaction, even after an abort.
    this.preparing = true;
  }

  /** Called only by the renderer's screen redraw, never by checkpoint rasterization. */
  present(): boolean {
    const changed = this.ready !== undefined;
    if (this.ready) {
      this.remove(this.held);
      this.held = undefined;
      this.removeFrame(this.active);
      this.active = this.ready;
      this.ready = undefined;
    }
    const frame = this.active;
    if (this.releasing && !this.preparing && frame) {
      // release() validated a canonical grid at ingress. Later ordinary output
      // can advance it before RAF; publish that grid instead of retaining a
      // snapshot whose signature can never match again. A new begin/abort still
      // keeps preparing=true and protects an incomplete pixel transaction.
      const source = this.raster(this.cursorVisible());
      this.blit(source, undefined, 0, 0, source.width, source.height);
      this.invalidate();
      for (const listener of this.listeners) listener(undefined, frame.presentation);
      return true;
    }
    if (frame) {
      // Native selection/atlas redraws at a truly canonical origin remain visible.
      if (
        !this.preparing &&
        frame.presentation.fraction === 0 &&
        frame.canonical === this.signature()
      ) {
        const source = this.raster();
        this.blit(source, frame.image, 0, 0, source.width, source.height);
        this.remove(frame.cursor?.image);
        frame.cursor = this.captureCursor();
      }
      this.draw(frame);
      if (changed) for (const listener of this.listeners) listener(frame.presentation);
      return true;
    }
    if (this.held) {
      this.blit(this.held, undefined, 0, 0, this.held.width, this.held.height);
      return true;
    }
    return false;
  }

  invalidate() {
    this.remove(this.pending);
    this.removeFrame(this.active);
    this.removeFrame(this.ready);
    this.remove(this.held);
    this.remove(this.scratch);
    this.pending = undefined;
    this.active = this.ready = undefined;
    this.held = this.scratch = undefined;
    this.preparing = this.releasing = false;
  }
}
