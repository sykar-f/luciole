// <luciole-mascot> — plays the exported spritesheet, crisp at any device pixel ratio.
//
//   <script type="module" src="luciole-mascot.js"></script>
//   <luciole-mascot src="out/spritesheet.png" meta="out/spritesheet.json"
//                   still="out/still.png" scale="2"></luciole-mascot>
//
// - Integer scaling on *physical* pixels (so 1.25x/1.5x screens stay sharp). The scale comes
//   from the `scale` attribute, else the CSS custom property --luciole-scale (so a media
//   query can make it smaller on phones), else 2.
// - prefers-reduced-motion: shows the still frame, and follows the setting live.
// - Pauses off screen (IntersectionObserver) and in background tabs.
// - Decorative by default (aria-hidden); set label="…" to expose it as an image.
// - Put an <img> inside as the no-JS fallback; it is hidden once the element upgrades.

const REDUCED = "(prefers-reduced-motion: reduce)";

class LucioleMascot extends HTMLElement {
  #canvas = document.createElement("canvas");
  #ctx = this.#canvas.getContext("2d");
  #sheet = null;
  #still = null;
  #meta = null;
  #raf = 0;
  #visible = false;
  #frame = -1;
  #t0 = 0;
  #cleanup = [];

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
    } else this.setAttribute("aria-hidden", "true");
    this.#load().catch((error) => console.error("luciole-mascot:", error));
  }

  disconnectedCallback() {
    cancelAnimationFrame(this.#raf);
    this.#cleanup.forEach((fn) => fn());
    this.#cleanup = [];
  }

  async #load() {
    const image = (src) =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`cannot load ${src}`));
        img.src = src;
      });
    const metaUrl = this.getAttribute("meta");
    const [meta, sheet, still] = await Promise.all([
      metaUrl ? fetch(metaUrl).then((r) => r.json()) : null,
      image(this.getAttribute("src")),
      this.hasAttribute("still") ? image(this.getAttribute("still")) : null,
    ]);
    const num = (name, fallback) => Number(this.getAttribute(name) ?? meta?.[name] ?? fallback);
    this.#meta = {
      frameWidth: num("frameWidth", 0),
      frameHeight: num("frameHeight", 0),
      frames: num("frames", 1),
      columns: num("columns", 1),
      fps: num("fps", 10),
    };
    if (!this.#meta.frameWidth || !this.#meta.frameHeight)
      throw new Error("missing frame size (meta or frameWidth/frameHeight attributes)");
    this.#sheet = sheet;
    this.#still = still;
    this.#resize();
    this.#t0 = performance.now();

    const media = matchMedia(REDUCED);
    const onMotion = () => this.#update();
    media.addEventListener("change", onMotion);
    const onDpr = () => {
      this.#resize();
      this.#frame = -1;
      this.#update();
    };
    // --luciole-scale may change with media queries: re-read it when the viewport does.
    let pending = 0;
    const onResize = () => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(onDpr);
    };
    addEventListener("resize", onResize);
    const dprQuery = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
    dprQuery.addEventListener("change", onDpr, { once: true });
    const io = new IntersectionObserver(([entry]) => {
      this.#visible = entry.isIntersecting;
      this.#update();
    });
    io.observe(this);
    const onVisibility = () => this.#update();
    document.addEventListener("visibilitychange", onVisibility);
    this.#cleanup.push(
      () => media.removeEventListener("change", onMotion),
      () => dprQuery.removeEventListener("change", onDpr),
      () => io.disconnect(),
      () => document.removeEventListener("visibilitychange", onVisibility),
      () => removeEventListener("resize", onResize),
    );
    for (const child of this.querySelectorAll("img")) child.hidden = true;
  }

  #resize() {
    const { frameWidth, frameHeight } = this.#meta;
    const fromCss = Number.parseFloat(getComputedStyle(this).getPropertyValue("--luciole-scale"));
    const scale = Math.max(
      1,
      Number(this.getAttribute("scale") ?? (Number.isFinite(fromCss) ? fromCss : 2)),
    );
    const physical = Math.max(1, Math.round(scale * devicePixelRatio)); // whole device pixels per sprite pixel
    this.#canvas.width = frameWidth * physical;
    this.#canvas.height = frameHeight * physical;
    this.#canvas.style.width = `${(frameWidth * physical) / devicePixelRatio}px`;
    this.#canvas.style.height = `${(frameHeight * physical) / devicePixelRatio}px`;
    this.#ctx.imageSmoothingEnabled = false;
  }

  #update() {
    cancelAnimationFrame(this.#raf);
    if (!this.#sheet) return;
    if (matchMedia(REDUCED).matches) {
      this.#drawStill();
      return;
    }
    if (!this.#visible || document.hidden) return;
    const tick = (now) => {
      const { frames, fps } = this.#meta;
      const frame = Math.floor(((now - this.#t0) / 1000) * fps) % frames;
      if (frame !== this.#frame) this.#drawFrame(frame);
      this.#raf = requestAnimationFrame(tick);
    };
    this.#raf = requestAnimationFrame(tick);
  }

  #drawFrame(frame) {
    const { frameWidth: w, frameHeight: h, columns } = this.#meta;
    const c = this.#canvas;
    this.#ctx.clearRect(0, 0, c.width, c.height);
    this.#ctx.drawImage(
      this.#sheet,
      (frame % columns) * w,
      Math.floor(frame / columns) * h,
      w,
      h,
      0,
      0,
      c.width,
      c.height,
    );
    this.#frame = frame;
  }

  #drawStill() {
    if (!this.#still) {
      this.#drawFrame(0);
      return;
    }
    const c = this.#canvas;
    this.#ctx.clearRect(0, 0, c.width, c.height);
    this.#ctx.drawImage(this.#still, 0, 0, c.width, c.height);
    this.#frame = -1;
  }
}

if (!customElements.get("luciole-mascot")) customElements.define("luciole-mascot", LucioleMascot);
