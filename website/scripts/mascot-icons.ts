/**
 * The mascot at icon sizes, framed as the lab (/lab/mascot, F) settled:
 * - public/favicon.svg: the small drawing (the one `luciole init` shows), pixel for pixel, from
 *   the antennae's lights to the top of the lantern: 30 x 32 pixels in a 32 x 32 square.
 * - public/mascot/avatar.png: the still, on the site's night, cropped to the 66 sprite pixels
 *   the avatar circle spans (centred on the head, the light rising from the bottom edge).
 * Rerun after a change to either drawing:
 *   bun website/scripts/mascot-icons.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { MASCOT_PALETTE, MASCOT_PIXELS } from "../../packages/luciole/src/mascot-sprite.gen";

const PUBLIC = join(import.meta.dirname, "../public");
const PIXEL_KEYS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const NIGHT = "#0b0a07";

// Favicon: rows 2 to 33 of the small drawing, one column of margin each side.
const ICON = 32;
const FIRST_ROW = 2;
const rows = MASCOT_PIXELS.slice(FIRST_ROW, FIRST_ROW + ICON);
const margin = (ICON - (rows[0]?.length ?? 0)) / 2;
const rects: string[] = [];
for (const [y, row] of rows.entries()) {
  // One rect per run of a colour along the row, to keep the file small.
  for (let x = 0; x < row.length;) {
    const key = row[x];
    let end = x + 1;
    while (row[end] === key) end++;
    if (key !== ".") {
      const colour = MASCOT_PALETTE[PIXEL_KEYS.indexOf(key ?? "")]?.replace(/ff$/, "");
      if (!colour) throw new Error(`mascot-icons: no colour for pixel ${JSON.stringify(key)}`);
      rects.push(
        `<rect x="${x + margin}" y="${y}" width="${end - x}" height="1" fill="${colour}"/>`,
      );
    }
    x = end;
  }
}
writeFileSync(
  join(PUBLIC, "favicon.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ICON} ${ICON}" shape-rendering="crispEdges">${rects.join("")}</svg>\n`,
);

// Avatar: the lab's circle spans x 10 to 76 and y 12.5 to 78.5 of the 86 x 113 still. Doubled
// first, so the half pixel falls on a whole one, then scaled up without smoothing.
const STILL_WIDTH = 86;
const CIRCLE = { left: 10, top: 12.5, span: 66 };
const AVATAR = 528;
// sharp applies one resize per pipeline: the doubling is a pipeline of its own.
const doubled = await sharp(join(PUBLIC, "mascot/still.png"))
  .resize({ width: STILL_WIDTH * 2, kernel: "nearest" })
  .toBuffer();
await sharp(doubled)
  .extract({
    left: CIRCLE.left * 2,
    top: CIRCLE.top * 2,
    width: CIRCLE.span * 2,
    height: CIRCLE.span * 2,
  })
  .resize({ width: AVATAR, kernel: "nearest" })
  .flatten({ background: NIGHT })
  .png()
  .toFile(join(PUBLIC, "mascot/avatar.png"));

console.log("mascot-icons: public/favicon.svg, public/mascot/avatar.png");
