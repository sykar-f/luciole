// The live afterglow: each cell an application rewrites in a framed web runtime glows a
// moment over it, as in the demos' intro. Told by the frame's own terminal (same origin,
// docs/WEB.md "Page embarquée", `lucioleWrites`): at each of its renders, the cells that
// differ from the last one, character or style.
import * as z from "zod/mini";
import { strength } from "./afterglow";

/** How long a written cell of the live application glows at full strength. */
const GLOW_MS = 450;
/** However strongly the screen changes, a cell glows at least this share of GLOW_MS. */
const SHORTEST_GLOW = 0.4;
/** Beyond this many runs at once, a row glows once, from its first change to its last. */
const MOST_GLOWS = 400;

type Run = [row: number, column: number, length: number];
const Written = z.array(z.object({ row: z.number(), column: z.number(), length: z.number() }));

/** Runs merged per row: from the row's first change to its last. */
function byRow(runs: Run[]) {
  const rows = new Map<number, [number, number]>();
  for (const [y, x, length] of runs) {
    const [from, to] = rows.get(y) ?? [x, x + length];
    rows.set(y, [Math.min(from, x), Math.max(to, x + length)]);
  }
  return [...rows].map(([y, [from, to]]): Run => [y, from, to - from]);
}

export type GlowOptions = {
  /** The web runtime's frame, drawn: its terminal tells its renders through its window. */
  frame: HTMLIFrameElement;
  /** Laid exactly over the frame: the glowing cells go there, as `<i>` elements. */
  layer: HTMLElement;
  columns: number;
  rows: number;
  signal: AbortSignal;
  /** Told how many cells each change wrote. */
  onWritten?: (cells: number) => void;
  /** Whether the cells glow now: told of the changes either way (`onWritten`). */
  shows?: () => boolean;
};

/** Makes each cell the frame's application rewrites glow, until `signal` aborts. */
export function glowWrites({
  frame,
  layer,
  columns,
  rows,
  signal,
  onWritten,
  shows = () => true,
}: GlowOptions) {
  const inner = frame.contentWindow;
  const screen = frame.contentDocument?.querySelector<HTMLElement>(".xterm-screen");
  const subscribe: unknown = inner ? Reflect.get(inner, "lucioleWrites") : undefined;
  if (!inner || !screen || typeof subscribe !== "function") return;
  const total = columns * rows;
  const rendered = (told: unknown, count: unknown) => {
    if (signal.aborted) return;
    const written = z.number().safeParse(count).data ?? 0;
    const parsed = Written.safeParse(told);
    if (!written || !parsed.success) return;
    onWritten?.(written);
    if (!shows()) return;
    const box = screen.getBoundingClientRect();
    const width = box.width / columns;
    const height = box.height / rows;
    const runs = parsed.data.map(({ row, column, length }): Run => [row, column, length]);
    // Dimmer and shorter as more of the screen changes at once.
    const glow = strength(written, total);
    const lasting = Math.round(GLOW_MS * Math.max(SHORTEST_GLOW, glow));
    const shown = runs.length > MOST_GLOWS ? byRow(runs) : runs;
    for (const [y, x, length] of shown) {
      const cell = document.createElement("i");
      cell.style.cssText = `left:${box.left + x * width}px;top:${box.top + y * height}px;width:${length * width}px;height:${height}px;--glow:${glow};--glow-ms:${lasting}ms`;
      cell.addEventListener("animationend", () => cell.remove());
      layer.append(cell);
    }
  };
  const stop: unknown = Reflect.apply(subscribe, inner, [rendered]);
  signal.addEventListener("abort", () => {
    if (typeof stop === "function") Reflect.apply(stop, inner, []);
    layer.replaceChildren();
  });
}
