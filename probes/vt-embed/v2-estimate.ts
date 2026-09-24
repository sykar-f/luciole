// v2 sketch: instead of a VT stream, a child airtty app would send the diffs of its
// OpenTUI cell buffer over IPC. How many bytes would that cost compared with the VT bytes
// for the same screens? Each recorded stream is replayed into OpenTUI's embedded terminal;
// after every "frame" (a 4 KiB PTY read, worst case; or 64 KiB, what a 60 Hz host
// coalesces under load) the composed buffer is compared cell by cell with the previous
// one. Run: `bun v2-estimate.ts`.
import { EmbeddedTerminalRenderable, OptimizedBuffer } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { STREAM_COLS, STREAM_NAMES, STREAM_ROWS, stream } from "./streams";
import { saveSection } from "./results";

const KIB = 1024;
const PTY_READ = 4096;
const COALESCED = 65_536;
const FRAME_SIZES = [PTY_READ, COALESCED];
const U8 = 1;
const U16 = 2;
const U32 = 4;
const RGB24 = 3;
const RGBA_U16 = 8;
// Raw OpenTUI cell as the buffers hold it: char u32, fg and bg as 4 × u16 each, attrs u32;
// plus a u32 cell index per changed cell.
const RAW_CELL_BYTES = U32 + RGBA_U16 + RGBA_U16 + U32 + U32;
// A compact wire cell: u16 index (runs make most indexes implicit), UTF-8 char (1–4, 2 on
// average here), 24-bit fg and bg, u8 attributes.
const COMPACT_CELL_BYTES = U16 + U16 + RGB24 + RGB24 + U8;
const RATIO_DECIMALS = 100;

const setup = await createTestRenderer({ width: STREAM_COLS, height: STREAM_ROWS });
const results: Record<string, Record<string, number>> = {};
for (const name of STREAM_NAMES) {
  const bytes = await stream(name);
  for (const frameBytes of FRAME_SIZES) {
    const term = new EmbeddedTerminalRenderable(setup.renderer, { width: "100%", height: "100%" });
    setup.renderer.root.add(term);
    await setup.renderOnce();
    const target = OptimizedBuffer.create(STREAM_COLS, STREAM_ROWS, "unicode");
    const planes = () => {
      const b = target.buffers;
      return [b.char.slice(), b.fg.slice(), b.bg.slice(), b.attributes.slice()] as const;
    };
    let previous = planes();
    let frames = 0;
    let changed = 0;
    for (let i = 0; i < bytes.byteLength; i += frameBytes) {
      term.write(bytes.subarray(i, i + frameBytes));
      term.invalidate();
      term.render(target, 0);
      const next = planes();
      const [char, fg, bg, attributes] = next;
      const cells = char.length;
      const colorsPerCell = fg.length / cells;
      for (let c = 0; c < cells; c++) {
        let differs = char[c] !== previous[0][c] || attributes[c] !== previous[3][c];
        for (let k = 0; !differs && k < colorsPerCell; k++)
          differs =
            fg[c * colorsPerCell + k] !== previous[1][c * colorsPerCell + k] ||
            bg[c * colorsPerCell + k] !== previous[2][c * colorsPerCell + k];
        if (differs) changed++;
      }
      previous = next;
      frames++;
    }
    const compact = changed * COMPACT_CELL_BYTES;
    results[`${name} / ${frameBytes / KIB} KiB frames`] = {
      "VT bytes": bytes.byteLength,
      frames,
      "changed cells": changed,
      "raw diff bytes": changed * RAW_CELL_BYTES,
      "compact diff bytes": compact,
      "compact / VT": Math.round((compact / bytes.byteLength) * RATIO_DECIMALS) / RATIO_DECIMALS,
    };
    target.destroy();
    term.destroy();
  }
}
setup.renderer.destroy();
console.log(results);
await saveSection("v2Estimate", { cols: STREAM_COLS, rows: STREAM_ROWS, results });
process.exit(0);
