// node export.mjs — renders the shared CYCLE into files for the site:
//   out/spritesheet.png   8x8 grid of 64 frames (100 ms each, 6.4 s seamless loop)
//   out/spritesheet.json  frame size, count, columns, fps (read by luciole-mascot.js)
//   out/spritesheet-light.png, out/still-light.png  same with a faint halo, for light backgrounds
//   out/spritesheet-start.png  1 px float, for the Start section where it sits on the command box
//   out/still.png         one calm frame (reduced motion, no-JS fallback, og images)
//   out/still-404.png     lantern almost off, eyes half closed, face kept readable
//   out/avatar.png        462 px, framed on the head, the lantern rising from the bottom
//   out/avatar-small.png  the small drawing, for avatars of 32 px and less
//   out/luciole.gif       4x preview, exact 10 cs delays
//   out/frames/NN.png     every frame
import { renderAt, renderState, CYCLE, FRAME_W, FRAME_H } from "./luciole-sprite.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";

const FPS = 10,
  N = Math.round(CYCLE.loop * FPS),
  COLS = 8;
rmSync("out", { recursive: true, force: true });
mkdirSync("out", { recursive: true });
const img = { data: new Uint8ClampedArray(FRAME_W * FRAME_H * 4) };
const save = (path) => {
  writeFileSync(`${path}.rgba`, img.data);
  execFileSync("magick", [
    "-size",
    `${FRAME_W}x${FRAME_H}`,
    "-depth",
    "8",
    `rgba:${path}.rgba`,
    `${path}.png`,
  ]);
  rmSync(`${path}.rgba`);
};
function sheet(suffix, cfg) {
  mkdirSync(`out/frames${suffix}`, { recursive: true });
  const frames = [];
  for (let i = 0; i < N; i++) {
    renderAt(img, i / FPS, cfg);
    const path = `out/frames${suffix}/${String(i).padStart(2, "0")}`;
    save(path);
    frames.push(`${path}.png`);
  }
  renderState(img, { I: 0.5, halo: cfg.halo, onLight: cfg.onLight });
  save(`out/still${suffix}`);
  const rows = [];
  for (let r = 0; r < N / COLS; r++)
    rows.push("(", ...frames.slice(r * COLS, r * COLS + COLS), "+append", ")");
  execFileSync("magick", [
    ...rows,
    "-background",
    "none",
    "-append",
    `out/spritesheet${suffix}.png`,
  ]);
  return frames;
}
const frames = sheet("", CYCLE);
sheet("-light", { ...CYCLE, halo: 0.35, onLight: true });
sheet("-start", { ...CYCLE, floatAmplitude: 1 });
writeFileSync(
  "out/spritesheet.json",
  JSON.stringify(
    { frameWidth: FRAME_W, frameHeight: FRAME_H, frames: N, columns: COLS, fps: FPS },
    null,
    2,
  ) + "\n",
);
renderState(img, { I: 0.08, blink: 1, ambient: 0.72 });
save("out/still-404");
// Avatar: a 66 px square of the frame (from x 10, y 12), scaled 7x with no smoothing.
execFileSync("magick", [
  "out/still.png",
  "-background",
  "#0b0a07",
  "-alpha",
  "remove",
  "-crop",
  "66x66+10+12",
  "+repage",
  "-filter",
  "point",
  "-resize",
  "700%",
  "out/avatar.png",
]);
execFileSync("magick", [
  "small/small-final.png",
  "-background",
  "#0b0a07",
  "-alpha",
  "remove",
  "-crop",
  "27x27+1+5",
  "+repage",
  "-filter",
  "point",
  "-resize",
  "1700%",
  "out/avatar-small.png",
]);
execFileSync("magick", [
  "-delay",
  String(100 / FPS),
  "-loop",
  "0",
  "-dispose",
  "background",
  ...frames,
  "-filter",
  "point",
  "-resize",
  "400%",
  "-background",
  "#0b0a07",
  "-alpha",
  "remove",
  "out/luciole.gif",
]);
console.log(
  `${N} frames ${FRAME_W}x${FRAME_H} at ${FPS} fps, spritesheet ${FRAME_W * COLS}x${FRAME_H * (N / COLS)}`,
);
