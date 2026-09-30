/**
 * Moving the selection with the keyboard: in reading order (columns left to right, a
 * column top to bottom, as a left-to-right flow reads), along the edges (downstream,
 * upstream), among siblings, or to the nearest node on one side. Pure functions of the
 * graph and the nodes' positions.
 */
import type { Edge, Node, Position, XY } from "./types";

type Located = { id: string; at: XY };

const byColumn = (a: Located, b: Located) => a.at.x - b.at.x || a.at.y - b.at.y;
const byRow = (a: Located, b: Located) => a.at.y - b.at.y || a.at.x - b.at.x;

/** Selectable, visible nodes with their positions, in reading order. */
export function readingOrder(nodes: readonly Node[], positions: ReadonlyMap<string, XY>) {
  return nodes
    .filter((n) => !n.hidden && n.selectable !== false && n.type !== "group")
    .map((n) => ({ id: n.id, at: positions.get(n.id) ?? n.position }))
    .sort(byColumn);
}

/** The next (`1`) or previous (`-1`) node after `current` in reading order, cycling. */
export function cycle(order: readonly Located[], current: string | undefined, step: 1 | -1) {
  if (order.length === 0) return undefined;
  const index = order.findIndex((n) => n.id === current);
  if (index < 0) return (step === 1 ? order[0] : order.at(-1))?.id;
  return order[(index + step + order.length) % order.length]?.id;
}

/** The first node `current`'s edges lead to (`down`) or come from (`up`), top first. */
export function follow(
  edges: readonly Edge[],
  order: readonly Located[],
  current: string,
  direction: "down" | "up",
) {
  const ids = new Set(
    edges
      .filter((e) => !e.hidden && (direction === "down" ? e.source : e.target) === current)
      .map((e) => (direction === "down" ? e.target : e.source)),
  );
  return order.filter((n) => ids.has(n.id)).sort(byRow)[0]?.id;
}

/**
 * The next (`1`) or previous (`-1`) sibling of `current`: another node an upstream node
 * of `current` leads to, top to bottom, cycling.
 */
export function sibling(
  edges: readonly Edge[],
  order: readonly Located[],
  current: string,
  step: 1 | -1,
) {
  const parents = new Set(edges.filter((e) => e.target === current).map((e) => e.source));
  const ids = new Set(edges.filter((e) => parents.has(e.source)).map((e) => e.target));
  // A root's siblings are the other roots.
  if (parents.size === 0) {
    const targets = new Set(edges.map((e) => e.target));
    for (const n of order) if (!targets.has(n.id)) ids.add(n.id);
  }
  const list = order.filter((n) => ids.has(n.id)).sort(byRow);
  return list.length > 1 ? cycle(list, current, step) : undefined;
}

/**
 * The nearest node on `side` of `current`: within a 45° cone first, by distance with rows
 * counted twice (a row is about two columns tall).
 */
export function nearest(order: readonly Located[], current: string, side: Position) {
  const from = order.find((n) => n.id === current);
  if (!from) return undefined;
  let best: { id: string; score: number } | undefined;
  for (const n of order) {
    if (n.id === current) continue;
    const dx = n.at.x - from.at.x;
    const dy = (n.at.y - from.at.y) * 2;
    const forward = side === "right" ? dx : side === "left" ? -dx : side === "bottom" ? dy : -dy;
    const across = side === "left" || side === "right" ? Math.abs(dy) : Math.abs(dx);
    if (forward <= 0) continue;
    // Outside the cone costs as much again as the distance across.
    const score = forward + across * (across > forward ? 2 : 1);
    if (!best || score < best.score) best = { id: n.id, score };
  }
  return best?.id;
}
