// Animated pixel-art luciole: it floats while its lantern breathes and lights it.
// Everything is computed per sprite pixel into a small ImageData; scale it up
// with integer factors and `image-rendering: pixelated`.
import { W, H, PALETTE, LANTERN_RAMP, PIXELS, CLASSES, LIGHT } from "./luciole-data.js";

/** One shared timing for the demo, the export and the site. The full loop is 2 breaths. */
export const CYCLE = Object.freeze({
  period: 3.2, // s, one breath of light and one float up-and-down
  floatAmplitude: 2, // px
  lightLead: 0.25, // fraction of a period the light runs ahead of the float
  antennaLag: 0.2, // s the antennae trail the body
  tipGlowLag: 0.25, // s the antenna tips trail the lantern's light
  blinkAt: 4.25, // s into the loop (mid-frame, so 10 fps exports get half, closed, half)
  loop: 6.4, // s, the whole animation (blink once every 2 breaths)
  halo: 1, // 0..1, lower it on light backgrounds
  onLight: false, // light page behind: the lantern's outer rings lose their olive cast
});

const CLS = { bg: 0, body: 1, lantern: 2, tip: 3, eye: 4, stalk: 5 };
const ALPH = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const lum = ([r, g, b]) => 0.3 * r + 0.59 * g + 0.11 * b;
const PAL = PALETTE.map(rgb);
const GLOW = rgb("#c6e85a");
const GLOW_HOT = rgb("#f2ffd8");
const NIGHT = rgb("#0b0a07");

// Room around the sprite for the halo and the float.
const PAD = 10;
export const FRAME_W = W + PAD * 2;
export const FRAME_H = H + PAD * 2;

// Lantern ramp extended by two darker and two brighter steps, so sliding the
// bands up or down never merges them: the rings keep their relief at the peak.
const EXT = 2;
const RAMP = [
  mix(PAL[LANTERN_RAMP[0]], NIGHT, 0.55),
  mix(PAL[LANTERN_RAMP[0]], NIGHT, 0.3),
  ...LANTERN_RAMP.map((i) => PAL[i]),
  mix(PAL[LANTERN_RAMP.at(-1)], GLOW_HOT, 0.45),
  GLOW_HOT,
];

// ---- Decode the matrix once -------------------------------------------------
const cells = [];
const opaque = new Uint8Array(FRAME_W * FRAME_H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const ch = PIXELS[y][x];
    if (ch === ".") continue;
    const cls = +CLASSES[y][x];
    const pal = ALPH.indexOf(ch);
    cells.push({
      x,
      y,
      cls,
      alb: PAL[pal],
      ramp: LANTERN_RAMP.indexOf(pal),
      light: +LIGHT[y][x] / 3,
      eye: -1,
    });
    // Antennae move, so the halo must also exist under their rest position.
    if (cls !== CLS.stalk && cls !== CLS.tip) opaque[(y + PAD) * FRAME_W + x + PAD] = 1;
  }
}
const at = new Map(cells.map((c) => [c.y * W + c.x, c]));
const isAntenna = (c) => c.cls === CLS.stalk || c.cls === CLS.tip;
// Antennae are drawn first so the head covers their base when they sink; a stalk
// pixel resting on the head is its base, stretched by 1 px when the antenna rises.
for (const c of cells) {
  const below = at.get((c.y + 1) * W + c.x);
  c.base = c.cls === CLS.stalk && below !== undefined && !isAntenna(below);
}
const drawOrder = [...cells.filter(isAntenna), ...cells.filter((c) => !isAntenna(c))];
const neighbour = (c, dx, dy) =>
  c.x + dx >= 0 && c.x + dx < W ? at.get((c.y + dy) * W + c.x + dx) : undefined;
const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function components(pred) {
  const seen = new Set(),
    out = [];
  for (const c of cells) {
    if (!pred(c) || seen.has(c)) continue;
    const comp = [],
      stack = [c];
    seen.add(c);
    while (stack.length) {
      const p = stack.pop();
      comp.push(p);
      for (const [dx, dy] of DIRS) {
        const n = neighbour(p, dx, dy);
        if (n && pred(n) && !seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    out.push(comp);
  }
  return out;
}

// Antenna tips: one halo per connected blob.
const tips = components((c) => c.cls === CLS.tip);
// Eyes: bounding box, the skin just above for the eyelid, the outline colour for the lid line.
const outline = PAL.reduce((a, b) => (lum(b) < lum(a) ? b : a));
const eyes = components((c) => c.cls === CLS.eye).map((comp, i) => {
  comp.forEach((c) => (c.eye = i));
  const xs = comp.map((c) => c.x),
    ys = comp.map((c) => c.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const counts = new Map();
  for (let y = y0 - 3; y < y0; y++)
    for (let x = x0; x <= x1; x++) {
      const c = at.get(y * W + x);
      if (c && c.cls === CLS.body && lum(c.alb) > 150)
        counts.set(c.alb, (counts.get(c.alb) ?? 0) + 1);
    }
  const skin = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? PAL[0];
  return { x0, x1, y0, y1, skin };
});

// Halo distances, precomputed once for every free position of the padded frame.
const lanternEdge = cells.filter(
  (c) =>
    c.cls === CLS.lantern && DIRS.some(([dx, dy]) => neighbour(c, dx, dy)?.cls !== CLS.lantern),
);
const tipPixels = tips.flat();
const halo = [];
for (let fy = 0; fy < FRAME_H; fy++) {
  for (let fx = 0; fx < FRAME_W; fx++) {
    if (opaque[fy * FRAME_W + fx]) continue;
    const x = fx - PAD,
      y = fy - PAD;
    let dLantern = Infinity,
      dTip = Infinity;
    for (const e of lanternEdge) dLantern = Math.min(dLantern, Math.hypot(e.x - x, e.y - y));
    for (const p of tipPixels) dTip = Math.min(dTip, Math.hypot(p.x - x, p.y - y));
    if (dLantern <= 8 || dTip <= 5) halo.push({ x, y, dLantern, dTip, checker: (x + y) & 1 });
  }
}

// ---- Time -> state -----------------------------------------------------------
const TAU = Math.PI * 2;
/** Light intensity 0..1 at time t: a sine breath running `lightLead` ahead of the float. */
export const intensityAt = (t, cfg = CYCLE) =>
  0.5 + 0.5 * Math.sin(TAU * (t / cfg.period + cfg.lightLead));
/** Float offset, whole pixels only. */
export const floatAt = (t, cfg = CYCLE) =>
  Math.round(cfg.floatAmplitude * Math.sin(TAU * (t / cfg.period)));
/** 0 open, 1 half closed, 2 closed. */
export function blinkAt(t, cfg = CYCLE) {
  const u = (((t % cfg.loop) + cfg.loop) % cfg.loop) - cfg.blinkAt;
  if (u < 0 || u >= 0.3) return 0;
  return u < 0.1 || u >= 0.2 ? 1 : 2;
}

export function stateAt(t, cfg = CYCLE) {
  const dy = floatAt(t, cfg);
  return {
    I: intensityAt(t, cfg),
    tipI: intensityAt(t - cfg.tipGlowLag, cfg),
    dy,
    antenna: floatAt(t - cfg.antennaLag, cfg) - dy, // where the antennae still are, relative to the body
    blink: blinkAt(t, cfg),
    halo: cfg.halo,
    onLight: cfg.onLight,
  };
}

// ---- Rendering -----------------------------------------------------------------
/**
 * Draw one state into a FRAME_W x FRAME_H ImageData.
 * `ambient` overrides how lit the body is (e.g. a readable face while the lantern is off).
 *
 * @param {{ data: Uint8ClampedArray }} img
 * @param {{ I: number, tipI?: number, dy?: number, antenna?: number, blink?: number,
 *   halo?: number, ambient?: number, onLight?: boolean }} state
 */
export function renderState(
  img,
  {
    I,
    tipI = I,
    dy = 0,
    antenna = 0,
    blink = 0,
    halo: haloStrength = 1,
    ambient: ambientOverride,
    onLight = false,
  },
) {
  const data = img.data;
  data.fill(0);
  const put = (x, y, r, g, b, a = 255) => {
    const fx = x + PAD,
      fy = y + PAD + dy;
    if (fx < 0 || fy < 0 || fx >= FRAME_W || fy >= FRAME_H) return;
    const i = (fy * FRAME_W + fx) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  };

  // 1. Halo: a solid inner band and a checkerboard fringe, following the real shapes.
  if (haloStrength > 0) {
    const rL = 1.5 + 4.5 * I,
      rT = 1.5 + 2 * tipI;
    const k = haloStrength * (0.55 + 0.45 * I) * 255;
    for (const h of halo) {
      let a = 0,
        onTip = false;
      if (h.dLantern <= rL) a = h.dLantern <= rL * 0.5 ? 0.42 : h.checker ? 0.26 : 0;
      if (h.dTip <= rT) {
        const aT = h.dTip <= rT * 0.5 ? 0.34 : h.checker ? 0.2 : 0;
        if (aT > a) {
          a = aT;
          onTip = true;
        }
      }
      if (a) put(h.x, h.y + (onTip ? antenna : 0), GLOW[0], GLOW[1], GLOW[2], Math.round(a * k));
    }
  }

  // 2. Sprite.
  const ambient = ambientOverride ?? Math.min(1, 0.5 + I); // source colours are the mid state; only the dim side darkens
  // Bands slide two steps down when dim but one step up at the peak: a small hot core,
  // not a large near-white disc.
  const shift = I < 0.5 ? Math.round((I - 0.5) * 4) : Math.round((I - 0.5) * 2.9);
  for (const c of drawOrder) {
    let col,
      yOff = 0;
    if (c.cls === CLS.lantern) {
      const level = Math.max(0, Math.min(RAMP.length - 1, c.ramp + EXT + shift));
      col = RAMP[level];
      // On a light page the darkest rings read olive: pull them toward the glow colour.
      if (onLight && level <= EXT + 1) col = mix(col, GLOW, 0.4);
    } else if (c.cls === CLS.tip) {
      const amb = Math.min(1, 0.5 + tipI);
      col = mix([c.alb[0] * amb, c.alb[1] * amb, c.alb[2] * amb], GLOW_HOT, 0.4 * tipI * tipI);
      yOff = antenna;
    } else {
      let alb = c.alb;
      if (c.eye >= 0 && blink) {
        const e = eyes[c.eye];
        const lidRow =
          blink === 2
            ? e.y0 + Math.round((e.y1 - e.y0) * 0.6)
            : e.y0 + Math.floor((e.y1 - e.y0) / 2);
        if (c.y === lidRow && c.x > e.x0 && c.x < e.x1) alb = outline;
        else if (blink === 2 || c.y < lidRow) alb = e.skin;
      }
      // Lantern light: the painted reception mask times the intensity, kept in bands.
      const lit = Math.round(c.light * I * 3) / 3;
      col = mix([alb[0] * ambient, alb[1] * ambient, alb[2] * ambient], GLOW, lit * 0.8);
      // The whole antenna moves as one rigid piece: bending a 2 px line by a
      // pixel makes stairs that read as a second antenna behind.
      if (c.cls === CLS.stalk) yOff = antenna;
    }
    const [r, g, b] = [Math.round(col[0]), Math.round(col[1]), Math.round(col[2])];
    put(c.x, c.y + yOff, r, g, b);
    if (c.base && yOff < 0) for (let k = yOff + 1; k <= 0; k++) put(c.x, c.y + k, r, g, b);
  }
}

export const renderAt = (img, t, cfg = CYCLE) => renderState(img, stateAt(t, cfg));

/**
 * Live procedural animation (the demo uses it to tune the cycle). For the site,
 * prefer the exported spritesheet with luciole-mascot.js. Returns a stop function.
 */
export function animateLuciole(canvases, cfg = CYCLE) {
  const list = [canvases].flat();
  for (const c of list) {
    c.width = FRAME_W;
    c.height = FRAME_H;
  }
  const ctxs = list.map((c) => c.getContext("2d"));
  const img = ctxs[0].createImageData(FRAME_W, FRAME_H);
  let raf = 0;
  const t0 = performance.now();
  const loop = (now) => {
    renderAt(img, (now - t0) / 1000, cfg); // render once, blit to every canvas
    for (const ctx of ctxs) ctx.putImageData(img, 0, 0);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(raf);
}
