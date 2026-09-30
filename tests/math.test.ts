/** `luciole/math`: TeX to a PNG, for the editor's display math. */
import { expect, test } from "bun:test";
import { renderMath } from "luciole/math";

const PNG = [0x89, 0x50, 0x4e, 0x47];

test("TeX becomes a PNG, taller for a taller formula", async () => {
  const options = { display: true, color: "#e6edf3", scale: 10 };
  const line = await renderMath("x^2", options);
  const fraction = await renderMath("\\frac{a}{b}", options);
  expect(Array.from(line.subarray(0, 4))).toEqual(PNG);
  // The PNG's height, from its header.
  const height = (png: Uint8Array) => new DataView(png.buffer, png.byteOffset).getUint32(20);
  expect(height(fraction)).toBeGreaterThan(height(line));
});

test("TeX MathJax cannot read is refused: the editor shows it as written", async () => {
  expect(
    renderMath("\\notacommand{x}", { display: true, color: "#fff", scale: 10 }),
  ).rejects.toThrow();
});
