// The automatic 1/3 reduction, as a PNG (1x) and enlarged x32 for Gemini.
import { mascotPixels } from "../terminal.mjs";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const rows = mascotPixels({ scale: 3, halo: 0 });
const h = rows.length,
  w = rows[0].length,
  buf = new Uint8Array(w * h * 3);
rows.forEach((r, y) => r.forEach((c, x) => buf.set(c ?? [11, 10, 7], (y * w + x) * 3)));
writeFileSync("auto.rgb", buf);
execFileSync("magick", ["-size", `${w}x${h}`, "-depth", "8", "rgb:auto.rgb", "auto-1x.png"]);
execFileSync("magick", ["auto-1x.png", "-filter", "point", "-resize", "3200%", "auto-x32.png"]);
console.log(w, h);
