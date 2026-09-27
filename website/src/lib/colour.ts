// A palette token as `#rrggbb`, whatever CSS computes it from (color-mix, hsl(from …)):
// terminals, URLs and bytes take plain sRGB. Read by painting it: a hidden element takes
// the token as its colour, a 1x1 canvas draws that colour, and its pixel is the answer.
const HEX = 16;
const BYTE_DIGITS = 2;

/** The red, green and blue bytes of a `#rrggbb` colour. */
export const bytesOf = (colour: string) =>
  (colour.slice(1).match(/../g) ?? []).map((pair) => Number.parseInt(pair, HEX));

/** Bytes (rounded) as `#rrggbb`. */
export const hexOf = (bytes: readonly number[]) =>
  `#${bytes.map((byte) => Math.round(byte).toString(HEX).padStart(BYTE_DIGITS, "0")).join("")}`;

let probe: HTMLElement | undefined;
let pixel: CanvasRenderingContext2D | null | undefined;

export function hex(token: string) {
  if (!probe) {
    probe = document.createElement("i");
    probe.hidden = true;
    document.body.append(probe);
  }
  pixel ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  probe.style.color = `var(${token})`;
  const computed = getComputedStyle(probe).color;
  if (!pixel) return computed;
  pixel.clearRect(0, 0, 1, 1);
  pixel.fillStyle = computed;
  pixel.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = pixel.getImageData(0, 0, 1, 1).data;
  return hexOf([r, g, b]);
}
