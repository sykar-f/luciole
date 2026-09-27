// A palette token as `#rrggbb`, whatever CSS computes it from (color-mix, hsl(from …)):
// terminals, URLs and bytes take plain sRGB. Read by painting it: a hidden element takes
// the token as its colour, a 1x1 canvas draws that colour, and its pixel is the answer.
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
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}
