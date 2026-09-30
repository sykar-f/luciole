// <luciole-mascot>: plays the mascot's spritesheet (design/mascot/, exported to public/mascot/),
// crisp at any device pixel ratio.
//
// - Integer scaling on physical pixels, so 1.25x and 1.5x screens stay sharp. The scale is the
//   `scale` attribute, else the CSS property --luciole-scale (a media query can shrink it on
//   phones), else 2.
// - prefers-reduced-motion shows the still frame, and follows the setting live.
// - Loads nothing until it nears the viewport, and only the still frame under reduced motion.
// - Pauses off screen and in background tabs.
// - Decorative by default (aria-hidden); label="…" exposes it as an image.
// - An <img> inside is the no-JS fallback; it is hidden once the element runs.
import { z } from "zod";

const Sheet = z.object({
  frameWidth: z.number().int().positive(),
  frameHeight: z.number().int().positive(),
  frames: z.number().int().positive(),
  columns: z.number().int().positive(),
  fps: z.number().positive(),
});
type Sheet = z.infer<typeof Sheet>;

const REDUCED = "(prefers-reduced-motion: reduce)";
const DEFAULT_SCALE = 2;
const MS_PER_SECOND = 1000;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`luciole-mascot: cannot load ${src}`));
    img.src = src;
  });
}

class LucioleMascot extends HTMLElement {
  #canvas = document.createElement("canvas");
  #sheet: HTMLImageElement | undefined;
  #still: HTMLImageElement | undefined;
  #meta: Sheet | undefined;
  #raf = 0;
  #visible = false;
  #frame = -1;
  #t0 = 0;
  #started = false;
  #loadingSheet = false;
  #cleanup: (() => void)[] = [];

  connectedCallback() {
    const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent =
      ":host{display:inline-block;line-height:0}canvas{image-rendering:pixelated;image-rendering:crisp-edges}";
    root.replaceChildren(style, this.#canvas);
    const label = this.getAttribute("label");
    if (label) {
      this.setAttribute("role", "img");
      this.setAttribute("aria-label", label);
    } else {
      this.setAttribute("aria-hidden", "true");
    }
    // Start loading ~one screen before it scrolls into view; then track visibility.
    const observer = new IntersectionObserver(
      ([entry]) => {
        this.#visible = entry?.isIntersecting ?? false;
        if (!this.#started) {
          this.#started = true;
          this.#load().catch((error: unknown) => console.error(error));
        }
        this.#update();
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(this);
    this.#cleanup.push(() => observer.disconnect());
  }

  disconnectedCallback() {
    cancelAnimationFrame(this.#raf);
    for (const undo of this.#cleanup) undo();
    this.#cleanup = [];
    // Moved elsewhere in the page: set up again (the images come from the cache).
    this.#started = false;
  }

  async #load() {
    const metaUrl = this.getAttribute("meta");
    if (!this.getAttribute("src") || !metaUrl)
      throw new Error("luciole-mascot: src and meta are required");
    const stillUrl = this.getAttribute("still");
    const [meta, still] = await Promise.all([
      fetch(metaUrl).then(async (response) => Sheet.parse(await response.json())),
      stillUrl ? loadImage(stillUrl) : undefined,
    ]);
    this.#meta = meta;
    this.#still = still;
    this.#resize();
    this.#t0 = performance.now();

    const motion = matchMedia(REDUCED);
    const onChange = () => this.#update();
    motion.addEventListener("change", onChange);
    // The scale may change with the viewport (media queries) or the pixel ratio (zoom).
    let pending = 0;
    const onResize = () => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        this.#resize();
        this.#frame = -1;
        this.#update();
      });
    };
    addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onChange);
    this.#cleanup.push(
      () => motion.removeEventListener("change", onChange),
      () => removeEventListener("resize", onResize),
      () => document.removeEventListener("visibilitychange", onChange),
    );
    for (const fallback of this.querySelectorAll("img")) fallback.hidden = true;
    this.#update();
  }

  /** The spritesheet, fetched only once motion is allowed. */
  #loadSheet() {
    const src = this.getAttribute("src");
    if (this.#sheet || this.#loadingSheet || !src) return;
    this.#loadingSheet = true;
    loadImage(src)
      .then((sheet) => {
        this.#sheet = sheet;
        this.#update();
      })
      .catch((error: unknown) => console.error(error))
      .finally(() => (this.#loadingSheet = false));
  }

  #context() {
    const ctx = this.#canvas.getContext("2d");
    if (ctx) ctx.imageSmoothingEnabled = false;
    return ctx;
  }

  #resize() {
    if (!this.#meta) return;
    const { frameWidth, frameHeight } = this.#meta;
    const fromCss = Number.parseFloat(getComputedStyle(this).getPropertyValue("--luciole-scale"));
    const asked = Number(
      this.getAttribute("scale") ?? (Number.isFinite(fromCss) ? fromCss : DEFAULT_SCALE),
    );
    // Whole device pixels per sprite pixel.
    const physical = Math.max(1, Math.round(Math.max(1, asked) * devicePixelRatio));
    this.#canvas.width = frameWidth * physical;
    this.#canvas.height = frameHeight * physical;
    this.#canvas.style.width = `${(frameWidth * physical) / devicePixelRatio}px`;
    this.#canvas.style.height = `${(frameHeight * physical) / devicePixelRatio}px`;
  }

  #update() {
    cancelAnimationFrame(this.#raf);
    const meta = this.#meta;
    if (!meta) return;
    if (matchMedia(REDUCED).matches) {
      this.#drawStill();
      return;
    }
    if (!this.#sheet) {
      this.#drawStill();
      this.#loadSheet();
      return;
    }
    if (!this.#visible || document.hidden) return;
    const tick = (now: number) => {
      const frame = Math.floor(((now - this.#t0) / MS_PER_SECOND) * meta.fps) % meta.frames;
      if (frame !== this.#frame) this.#drawFrame(frame);
      this.#raf = requestAnimationFrame(tick);
    };
    this.#raf = requestAnimationFrame(tick);
  }

  #drawFrame(frame: number) {
    const ctx = this.#context();
    if (!ctx || !this.#meta || !this.#sheet) return;
    const { frameWidth: w, frameHeight: h, columns } = this.#meta;
    const { width, height } = this.#canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(
      this.#sheet,
      (frame % columns) * w,
      Math.floor(frame / columns) * h,
      w,
      h,
      0,
      0,
      width,
      height,
    );
    this.#frame = frame;
  }

  #drawStill() {
    const ctx = this.#context();
    if (!ctx) return;
    if (!this.#still) {
      if (this.#sheet) this.#drawFrame(0);
      return;
    }
    const { width, height } = this.#canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(this.#still, 0, 0, width, height);
    this.#frame = -1;
  }
}

if (!customElements.get("luciole-mascot")) customElements.define("luciole-mascot", LucioleMascot);
