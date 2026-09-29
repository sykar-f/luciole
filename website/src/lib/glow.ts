// The live afterglow: each cell an application rewrites in a framed web runtime glows a
// moment over it, as in the demos' intro. Read from the frame's own terminal (same origin):
// its rows, compared cell by cell (character and style) at each frame of the page.
import { strength } from "./afterglow";

/** How long a written cell of the live application glows at full strength. */
const GLOW_MS = 450;
/** However strongly the screen changes, a cell glows at least this share of GLOW_MS. */
const SHORTEST_GLOW = 0.4;
/** Beyond this many runs at once, a row glows once, from its first change to its last. */
const MOST_GLOWS = 400;

type Run = [row: number, column: number, length: number];

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
  /** The web runtime's frame, drawn: its terminal is read through its document. */
  frame: HTMLIFrameElement;
  /** Laid exactly over the frame: the glowing cells go there, as `<i>` elements. */
  layer: HTMLElement;
  columns: number;
  rows: number;
  signal: AbortSignal;
  /** Told how many cells each change wrote. */
  onWritten?: (cells: number) => void;
};

/** Makes each cell the frame's application rewrites glow, until `signal` aborts. */
export function glowWrites({ frame, layer, columns, rows, signal, onWritten }: GlowOptions) {
  const inner = frame.contentDocument;
  const rowsElement = inner?.querySelector<HTMLElement>(".xterm-rows");
  const screen = inner?.querySelector<HTMLElement>(".xterm-screen");
  if (!rowsElement || !screen) return;
  const total = columns * rows;
  const cellsOf = (row: Element) => {
    const cells: string[] = [];
    for (const node of row.childNodes) {
      const look =
        node instanceof HTMLElement
          ? `${[...node.classList].filter((name) => !name.startsWith("xterm-cursor")).join(" ")}|${node.style.cssText}`
          : "";
      for (const char of node.textContent ?? "") cells.push(`${char}${look}`);
    }
    return cells;
  };
  const snapshot = () => [...rowsElement.children].map(cellsOf);
  let before = snapshot();
  let queued = false;
  const compare = () => {
    queued = false;
    if (signal.aborted) return;
    const after = snapshot();
    const box = screen.getBoundingClientRect();
    const width = box.width / columns;
    const height = box.height / rows;
    const runs: Run[] = [];
    let written = 0;
    after.forEach((cells, y) => {
      const old = before[y] ?? [];
      let start = -1;
      for (let x = 0; x <= columns; x++) {
        const changed = x < columns && (cells[x] ?? "") !== (old[x] ?? "");
        if (changed) written++;
        if (changed && start < 0) start = x;
        if (!changed && start >= 0) {
          runs.push([y, start, x - start]);
          start = -1;
        }
      }
    });
    before = after;
    if (!written) return;
    onWritten?.(written);
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
  const watch = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(compare);
  });
  watch.observe(rowsElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });
  signal.addEventListener("abort", () => {
    watch.disconnect();
    layer.replaceChildren();
  });
}
