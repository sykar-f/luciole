/**
 * Edges drawn on the cell grid. Orthogonal paths (step, smoothstep, aligned straight
 * edges) set four direction bits per cell; the bits of every edge in a cell are merged,
 * so a fork reads `├`, two lines meeting `┼`, and a crossing is a `┼` too. Curves
 * (bezier) and slanted straight lines are drawn in braille dots, two by four per cell.
 * Pure: the canvas copies the grid into OpenTUI's buffer, tests print it.
 */
import type { Position, Rect, XY } from "./types.ts";
import { getStepPoints } from "./vendor/xyflow/smoothstep.ts";
import { getBezierEdgeCenter, getControlWithCurvature } from "./vendor/xyflow/bezier.ts";

export type Role = "edge" | "selected" | "animated" | "label" | "marker" | "background" | "handle";
export type Cell = {
  char: string;
  role: Role;
  /** An explicit color, over the role's. */
  color?: string;
  /** The edge this cell belongs to, for hit testing. */
  owner?: string;
};

// Direction bits of a box cell.
const N = 1;
const E = 2;
const S = 4;
const W = 8;
const BRAILLE_BASE = 0x2800;
const DOTS_X = 2;
const DOTS_Y = 4;
// Braille dots: 1-2-3 down the left column, 4-5-6 down the right, then 7 and 8 below.
const UPPER_ROWS = 3;
const LOWER_DOTS = 6;
const brailleBit = (column: number, row: number) =>
  row < UPPER_ROWS ? 1 << (row + column * UPPER_ROWS) : 1 << (LOWER_DOTS + column);
/** Cells of an animated edge: one runner every this many. */
const RUNNER_EVERY = 4;
/** Bezier samples per cell of distance. */
const SAMPLES_PER_CELL = 6;
/** Curvature for backward bezier edges: xyflow's 0.25 is tuned for pixels. */
const CELL_CURVATURE = 0.06;

const SQUARE: Record<number, string> = {
  [N]: "│",
  [S]: "│",
  [N | S]: "│",
  [E]: "─",
  [W]: "─",
  [E | W]: "─",
  [E | S]: "┌",
  [W | S]: "┐",
  [N | E]: "└",
  [N | W]: "┘",
  [N | E | S]: "├",
  [N | W | S]: "┤",
  [E | W | S]: "┬",
  [N | E | W]: "┴",
  [N | E | S | W]: "┼",
};
const ROUNDED: Record<number, string> = {
  [E | S]: "╭",
  [W | S]: "╮",
  [N | E]: "╰",
  [N | W]: "╯",
};
const LINE_ROLES: ReadonlySet<Role> = new Set(["edge", "selected", "animated"]);
const DASHED: Record<number, string> = { [E | W]: "╌", [N | S]: "╎" };
const RUNNER: Record<number, string> = { [E | W]: "━", [N | S]: "┃" };

/** An arrow pointing into a node, by the side of the node it enters. */
export const ARROW_INTO: Record<Position, string> = {
  left: "▶",
  right: "◀",
  top: "▼",
  bottom: "▲",
};
const towardNode: Record<Position, number> = { left: E, right: W, top: S, bottom: N };

export type EdgeStyle = "smoothstep" | "step" | "straight" | "bezier";

/** An edge, placed: both ends are anchor cells, just outside their nodes. */
export type EdgeDraw = {
  id: string;
  style: EdgeStyle;
  source: XY;
  sourcePosition: Position;
  target: XY;
  targetPosition: Position;
  label?: string;
  animated?: boolean;
  selected?: boolean;
  markerEnd?: boolean;
  markerStart?: boolean;
  color?: string;
  /** For custom edge types: the path's corner points, drawn orthogonally. */
  points?: readonly XY[];
  /** Overrides the role its state gives it (the connection being made). */
  role?: Role;
};

type BoxCell = {
  mask: number;
  rounded: boolean;
  role: Role;
  color?: string;
  owner?: string;
  /** Index along its edge, for the runner of an animated edge. */
  index: number;
  edges: number;
};

const mod = (a: number, n: number) => ((a % n) + n) % n;

type DotCell = { bits: number; role: Role; color?: string; owner?: string; index?: number };

export class Grid {
  readonly width: number;
  readonly height: number;
  private readonly cells: (Cell | undefined)[];
  private readonly boxes = new Map<number, BoxCell>();
  private readonly dots = new Map<number, DotCell>();

  constructor(width: number, height: number) {
    this.width = Math.max(0, width);
    this.height = Math.max(0, height);
    this.cells = Array.from({ length: this.width * this.height }, () => undefined);
  }

  inside(x: number, y: number) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }
  get(x: number, y: number): Cell | undefined {
    return this.inside(x, y) ? this.cells[y * this.width + x] : undefined;
  }
  set(x: number, y: number, cell: Cell) {
    if (this.inside(x, y)) this.cells[y * this.width + x] = cell;
  }
  /** Writes `text` from (x, y) on, clipped to the grid. */
  text(x: number, y: number, text: string, cell: Omit<Cell, "char">) {
    Array.from(text).forEach((char, i) => this.set(x + i, y, { ...cell, char }));
  }

  /** Adds direction bits to a box cell; the last writer's role and color win. */
  box(x: number, y: number, bits: number, style: Omit<BoxCell, "mask" | "edges">) {
    if (!this.inside(x, y)) return;
    const key = y * this.width + x;
    const known = this.boxes.get(key);
    this.boxes.set(key, {
      ...style,
      mask: (known?.mask ?? 0) | bits,
      rounded: style.rounded && (known?.rounded ?? true),
      edges: (known?.edges ?? 0) + (known?.owner === style.owner ? 0 : 1),
    });
  }

  /** Sets one braille dot at dot coordinates (two per cell across, four down). */
  dot(dx: number, dy: number, style: Omit<DotCell, "bits">) {
    const x = Math.floor(dx / DOTS_X);
    const y = Math.floor(dy / DOTS_Y);
    if (!this.inside(x, y) || dx < 0 || dy < 0) return;
    const key = y * this.width + x;
    const bit = brailleBit(dx - x * DOTS_X, dy - y * DOTS_Y);
    const known = this.dots.get(key);
    this.dots.set(key, { ...style, bits: (known?.bits ?? 0) | bit });
  }

  /**
   * Turns direction bits and dots into characters. Box lines win over dots, and cells
   * already set (markers, labels) win over both.
   */
  resolve(phase = 0) {
    for (const [key, d] of this.dots) {
      if (this.cells[key]) continue;
      // An animated curve: one cell in RUNNER_EVERY is dropped, and the gap moves.
      if (
        d.role === "animated" &&
        d.index !== undefined &&
        mod(d.index - phase, RUNNER_EVERY) === 0
      )
        continue;
      this.cells[key] = {
        char: String.fromCharCode(BRAILLE_BASE + d.bits),
        role: d.role,
        color: d.color,
        owner: d.owner,
      };
    }
    for (const [key, b] of this.boxes) {
      const known = this.cells[key];
      if (known && !LINE_ROLES.has(known.role)) continue;
      let char = (b.rounded ? ROUNDED[b.mask] : undefined) ?? SQUARE[b.mask] ?? "·";
      if (b.role === "animated" && b.edges === 1) {
        const runner = mod(b.index - phase, RUNNER_EVERY) === 0;
        char = (runner ? RUNNER[b.mask] : DASHED[b.mask]) ?? char;
      }
      this.cells[key] = { char, role: b.role, color: b.color, owner: b.owner };
    }
    this.boxes.clear();
    this.dots.clear();
    return this;
  }

  /** Rows of text, trailing blanks trimmed: what tests compare. */
  lines(): string[] {
    return Array.from({ length: this.height }, (_, y) =>
      Array.from({ length: this.width }, (_, x) => this.get(x, y)?.char ?? " ")
        .join("")
        .trimEnd(),
    );
  }
  /** Each cell that holds something, row by row. */
  *entries(): Generator<[number, number, Cell]> {
    for (let y = 0; y < this.height; y++)
      for (let x = 0; x < this.width; x++) {
        const cell = this.cells[y * this.width + x];
        if (cell) yield [x, y, cell];
      }
  }
}

/** The cells from `a` to `b` on one axis, `a` excluded, `b` included. */
function* segment(a: XY, b: XY): Generator<XY> {
  const dx = Math.sign(b.x - a.x);
  const dy = Math.sign(b.y - a.y);
  let { x, y } = a;
  while (x !== b.x || y !== b.y) {
    // A diagonal pair is walked horizontally then vertically.
    if (x !== b.x) x += dx;
    else y += dy;
    yield { x, y };
  }
}

const bitToward = (from: XY, to: XY) =>
  to.x > from.x ? E : to.x < from.x ? W : to.y > from.y ? S : to.y < from.y ? N : 0;

/** Rounds corner points and makes each pair of consecutive points share an axis. */
export function orthogonal(points: readonly XY[]): XY[] {
  const out: XY[] = [];
  for (const p of points) {
    const point = { x: Math.round(p.x), y: Math.round(p.y) };
    const last = out.at(-1);
    if (last && last.x === point.x && last.y === point.y) continue;
    if (last && last.x !== point.x && last.y !== point.y) out.push({ x: point.x, y: last.y });
    out.push(point);
  }
  return out;
}

/** The cells an orthogonal path goes through, in order, both ends included. */
export function pathCells(points: readonly XY[]): XY[] {
  const corners = orthogonal(points);
  const first = corners[0];
  if (!first) return [];
  const cells = [first];
  for (let i = 1; i < corners.length; i++) {
    const from = corners[i - 1];
    const to = corners[i];
    if (from && to) cells.push(...segment(from, to));
  }
  return cells;
}

/** The corner points of a step edge between two anchor cells. */
export function stepPoints(draw: EdgeDraw): { points: XY[]; label: XY } {
  const { points, labelX, labelY } = getStepPoints({
    source: draw.source,
    sourcePosition: draw.sourcePosition,
    target: draw.target,
    targetPosition: draw.targetPosition,
    offset: 1,
  });
  return { points, label: { x: Math.round(labelX), y: Math.round(labelY) } };
}

/** A cubic bezier's four points between two anchor cells, after xyflow's controls. */
export function bezierControls(draw: EdgeDraw): [XY, XY, XY, XY] {
  const { source: s, target: t } = draw;
  const [scx, scy] = getControlWithCurvature({
    pos: draw.sourcePosition,
    x1: s.x,
    y1: s.y,
    x2: t.x,
    y2: t.y,
    c: CELL_CURVATURE,
  });
  const [tcx, tcy] = getControlWithCurvature({
    pos: draw.targetPosition,
    x1: t.x,
    y1: t.y,
    x2: s.x,
    y2: s.y,
    c: CELL_CURVATURE,
  });
  return [s, { x: scx, y: scy }, { x: tcx, y: tcy }, t];
}

const CUBIC = 3;
const cubic = (a: number, b: number, c: number, d: number, t: number) => {
  const u = 1 - t;
  return u * u * u * a + CUBIC * u * u * t * b + CUBIC * u * t * t * c + t * t * t * d;
};

const roleOf = (draw: EdgeDraw): Role =>
  draw.role ?? (draw.selected ? "selected" : draw.animated ? "animated" : "edge");

/** Draws one edge into `grid`; returns where its label goes. */
export function drawEdge(grid: Grid, draw: EdgeDraw): XY {
  const role = roleOf(draw);
  const style = { role, color: draw.color, owner: draw.id };
  const aligned = draw.source.x === draw.target.x || draw.source.y === draw.target.y;
  let label: XY;
  if (draw.style === "bezier" || (draw.style === "straight" && !aligned)) {
    const [p0, p1, p2, p3] =
      draw.style === "bezier"
        ? bezierControls(draw)
        : [draw.source, draw.source, draw.target, draw.target];
    // Dot centers: a cell is 2 dots across and 4 down.
    const toDot = (v: number, per: number) => v * per + (per - 1) / 2;
    const length = Math.abs(p3.x - p0.x) + Math.abs(p3.y - p0.y) * 2 + 1;
    const samples = Math.max(2, Math.ceil(length * SAMPLES_PER_CELL));
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      // A dash of dots every few cells on an animated edge, moving with the phase.
      grid.dot(
        Math.round(toDot(cubic(p0.x, p1.x, p2.x, p3.x, t), DOTS_X)),
        Math.round(toDot(cubic(p0.y, p1.y, p2.y, p3.y, t), DOTS_Y)),
        { ...style, index: Math.floor(i / SAMPLES_PER_CELL) },
      );
    }
    const [cx, cy] = getBezierEdgeCenter({
      sourceX: p0.x,
      sourceY: p0.y,
      targetX: p3.x,
      targetY: p3.y,
      sourceControlX: p1.x,
      sourceControlY: p1.y,
      targetControlX: p2.x,
      targetControlY: p2.y,
    });
    label = { x: Math.round(cx), y: Math.round(cy) };
  } else {
    const step = draw.points || draw.style === "straight" ? undefined : stepPoints(draw);
    const route = draw.points ?? step?.points ?? [draw.source, draw.target];
    const cells = pathCells(route);
    const rounded = draw.style === "smoothstep";
    cells.forEach((cell, index) => {
      const prev = cells[index - 1];
      const next = cells[index + 1];
      let bits = (prev ? bitToward(cell, prev) : 0) | (next ? bitToward(cell, next) : 0);
      if (index === 0) bits |= towardNode[draw.sourcePosition];
      if (index === cells.length - 1) bits |= towardNode[draw.targetPosition];
      grid.box(cell.x, cell.y, bits, { rounded, index, ...style });
    });
    label = step?.label ?? cells[Math.floor(cells.length / 2)] ?? draw.source;
  }
  if (draw.markerEnd !== false)
    grid.set(draw.target.x, draw.target.y, {
      char: ARROW_INTO[draw.targetPosition],
      role: draw.selected ? "selected" : "marker",
      color: draw.color,
      owner: draw.id,
    });
  if (draw.markerStart)
    grid.set(draw.source.x, draw.source.y, {
      char: ARROW_INTO[draw.sourcePosition],
      role: draw.selected ? "selected" : "marker",
      color: draw.color,
      owner: draw.id,
    });
  return label;
}

/** An edge's label, centered on `at`, over the lines. */
export function drawLabel(grid: Grid, at: XY, text: string, owner: string) {
  const padded = ` ${text} `;
  grid.text(at.x - Math.floor(padded.length / 2), at.y, padded, { role: "label", owner });
}

export type BackgroundVariant = "dots" | "lines" | "cross";

/** Background marks every `gap` flow cells, following the viewport, in the empty cells. */
export function drawBackground(
  grid: Grid,
  viewport: { x: number; y: number; zoom: number },
  variant: BackgroundVariant,
  gap: XY,
) {
  const gx = Math.max(1, Math.round(gap.x * viewport.zoom));
  const gy = Math.max(1, Math.round(gap.y * viewport.zoom));
  for (let y = 0; y < grid.height; y++)
    for (let x = 0; x < grid.width; x++) {
      const onX = mod(x - viewport.x, gx) === 0;
      const onY = mod(y - viewport.y, gy) === 0;
      const char =
        variant === "lines"
          ? onX && onY
            ? "┼"
            : onX
              ? "│"
              : onY
                ? "─"
                : undefined
          : onX && onY
            ? variant === "cross"
              ? "+"
              : "·"
            : undefined;
      if (char && !grid.get(x, y)) grid.set(x, y, { char, role: "background" });
    }
}

/** Draws `rects` and a viewport outline, in braille, scaled into `grid`. */
export function drawMiniMap(
  grid: Grid,
  world: Rect,
  rects: readonly { rect: Rect; role: Role; color?: string }[],
  view: Rect,
) {
  const dotsW = grid.width * DOTS_X;
  const dotsH = grid.height * DOTS_Y;
  // A flow cell is one column by one row, and a dot half a column by a quarter row.
  const scale = Math.min(dotsW / (world.width * DOTS_X), dotsH / (world.height * DOTS_Y));
  const ox = (dotsW - world.width * DOTS_X * scale) / 2;
  const oy = (dotsH - world.height * DOTS_Y * scale) / 2;
  const toDots = (r: Rect) => ({
    x0: Math.floor(ox + (r.x - world.x) * DOTS_X * scale),
    y0: Math.floor(oy + (r.y - world.y) * DOTS_Y * scale),
    x1: Math.ceil(ox + (r.x + r.width - world.x) * DOTS_X * scale) - 1,
    y1: Math.ceil(oy + (r.y + r.height - world.y) * DOTS_Y * scale) - 1,
  });
  for (const { rect, role, color } of rects) {
    const d = toDots(rect);
    for (let y = d.y0; y <= Math.max(d.y0, d.y1); y++)
      for (let x = d.x0; x <= Math.max(d.x0, d.x1); x++) grid.dot(x, y, { role, color });
  }
  const v = toDots(view);
  const clampX = (x: number) => Math.max(0, Math.min(dotsW - 1, x));
  const clampY = (y: number) => Math.max(0, Math.min(dotsH - 1, y));
  for (let x = clampX(v.x0); x <= clampX(v.x1); x++) {
    grid.dot(x, clampY(v.y0), { role: "selected" });
    grid.dot(x, clampY(v.y1), { role: "selected" });
  }
  for (let y = clampY(v.y0); y <= clampY(v.y1); y++) {
    grid.dot(clampX(v.x0), y, { role: "selected" });
    grid.dot(clampX(v.x1), y, { role: "selected" });
  }
  grid.resolve();
  /** Minimap cell → flow point, for a click that recenters the view. */
  return (cell: XY): XY => ({
    x: world.x + (cell.x * DOTS_X + 1 - ox) / (DOTS_X * scale),
    y: world.y + (cell.y * DOTS_Y + DOTS_Y / 2 - oy) / (DOTS_Y * scale),
  });
}
