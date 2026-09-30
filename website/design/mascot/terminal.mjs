// The mascot as terminal text: one "▀" per cell, its foreground the upper pixel and its
// background the lower one (24-bit colour), so a cell holds two sprite pixels.
//
//   node terminal.mjs          prints the small mascot, as `luciole init` could on success
//   node terminal.mjs 2        the automatic 1/2 reduction of the big one, for comparison
//
// The default is luciole-small.js, a separate drawing made for this size (small/README.md):
// automatic reductions of the 66x93 master lose the eyes and the outline.
import { renderState, FRAME_W, FRAME_H } from "./luciole-sprite.js";
import * as SMALL from "./luciole-small.js";

const NIGHT = [11, 10, 7];

/** Render one state and reduce it by `scale` (most frequent colour per block). Returns rows of rgb|null. */
export function mascotPixels({
  scale = 2,
  I = 0.5,
  background = NIGHT,
  halo = 1,
  method = "snap",
} = {}) {
  const img = { data: new Uint8ClampedArray(FRAME_W * FRAME_H * 4) };
  renderState(img, { I, halo });
  const px = (x, y) => {
    const i = (y * FRAME_W + x) * 4,
      a = img.data[i + 3] / 255;
    if (a === 0) return null;
    // Halo pixels are translucent: flatten them onto the terminal background.
    return [0, 1, 2].map((k) => Math.round(img.data[i + k] * a + background[k] * (1 - a)));
  };
  const rows = [];
  for (let y = 0; y + scale <= FRAME_H; y += scale) {
    const row = [];
    for (let x = 0; x + scale <= FRAME_W; x += scale) {
      const counts = new Map();
      let empty = 0;
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
          const c = px(x + dx, y + dy);
          if (!c) {
            empty++;
            continue;
          }
          const key = c.join(",");
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      if (empty * 2 > scale * scale) {
        row.push(null);
        continue;
      }
      if (method === "mode") {
        const [key] = [...counts].sort((a, b) => b[1] - a[1])[0];
        row.push(key.split(",").map(Number));
        continue;
      }
      // "snap": average the block, then take the closest colour the block really contains,
      // so edges stay crisp colours of the sprite instead of the most frequent speck.
      const cols = [...counts].map(([k, n]) => [k.split(",").map(Number), n]);
      const total = cols.reduce((s, [, n]) => s + n, 0);
      const avg = [0, 1, 2].map((i) => cols.reduce((s, [c, n]) => s + c[i] * n, 0) / total);
      const dist = (c) => (c[0] - avg[0]) ** 2 + (c[1] - avg[1]) ** 2 + (c[2] - avg[2]) ** 2;
      row.push(cols.map(([c]) => c).sort((a, b) => dist(a) - dist(b))[0]);
    }
    rows.push(row);
  }
  // Trim empty borders.
  const used = (r) => r.some(Boolean);
  while (rows.length && !used(rows[0])) rows.shift();
  while (rows.length && !used(rows.at(-1))) rows.pop();
  const cols = rows[0].map((_, x) => rows.some((r) => r[x]));
  const x0 = cols.indexOf(true),
    x1 = cols.lastIndexOf(true);
  return rows.map((r) => r.slice(x0, x1 + 1));
}

/** The small drawing as rows of rgb|null, its translucent glow flattened onto `background`. */
export function smallPixels({ background = NIGHT } = {}) {
  const pal = SMALL.PALETTE.map((h) => [1, 3, 5, 7].map((i) => parseInt(h.slice(i, i + 2), 16)));
  return SMALL.PIXELS.map((row) =>
    [...row].map((ch) => {
      if (ch === ".") return null;
      const [r, g, b, a255] =
          pal["0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".indexOf(ch)],
        a = a255 / 255;
      return [r, g, b].map((v, k) => Math.round(v * a + background[k] * (1 - a)));
    }),
  );
}

/** Pair rows into half-block cells: [{ top, bottom }] per line (null = terminal background). */
export function halfBlocks(rows) {
  const lines = [];
  for (let y = 0; y < rows.length; y += 2) {
    lines.push(rows[y].map((top, x) => ({ top, bottom: rows[y + 1]?.[x] ?? null })));
  }
  return lines;
}

/** ANSI truecolor string. Transparent halves use the terminal's own background. */
export function toAnsi(lines) {
  const fg = (c) => `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`,
    bg = (c) => `\x1b[48;2;${c[0]};${c[1]};${c[2]}m`;
  return lines
    .map((line) =>
      line
        .map(({ top, bottom }) => {
          if (!top && !bottom) return " ";
          if (top && bottom) return `${fg(top)}${bg(bottom)}▀\x1b[0m`;
          return top ? `${fg(top)}▀\x1b[0m` : `${fg(bottom)}▄\x1b[0m`;
        })
        .join(""),
    )
    .join("\n");
}

// Run as a script (Node), not when imported by a page.
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
  const scale = process.argv[2] ? Number(process.argv[2]) : 0;
  const lines = halfBlocks(scale ? mascotPixels({ scale }) : smallPixels());
  // The useful part first; the picture is a greeting, not the message.
  console.log(
    `\n  \x1b[1mmy-app\x1b[0m is ready.\n  Next: \x1b[1mcd my-app && bun install\x1b[0m\n`,
  );
  console.log(toAnsi(lines));
  console.error(
    `\n(${lines[0].length} columns x ${lines.length} rows${scale ? `, reduction 1/${scale}` : ", small drawing"})`,
  );
}
