// Adapted from xyflow, packages/system/src/utils/edges/bezier-edge.ts and
// utils/edges/general.ts (MIT, see LICENSE and README.md in this directory): the control
// points and centers as numbers instead of an SVG path.
import type { Position } from "../../types.ts";

const HALF = 0.5;
// cubic bezier t=0.5 mid point weights: (1-t)^3, 3t(1-t)^2, 3t^2(1-t), t^3
const END_WEIGHT = 0.125;
const CONTROL_WEIGHT = 0.375;
const CURVATURE_SCALE = 25;

// this is used for straight edges and simple smoothstep edges (LTR, RTL, BTT, TTB)
export function getEdgeCenter({
  sourceX,
  sourceY,
  targetX,
  targetY,
}: {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
}): [number, number, number, number] {
  const xOffset = Math.abs(targetX - sourceX) / 2;
  const centerX = targetX < sourceX ? targetX + xOffset : targetX - xOffset;

  const yOffset = Math.abs(targetY - sourceY) / 2;
  const centerY = targetY < sourceY ? targetY + yOffset : targetY - yOffset;

  return [centerX, centerY, xOffset, yOffset];
}

export function getBezierEdgeCenter({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourceControlX,
  sourceControlY,
  targetControlX,
  targetControlY,
}: {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourceControlX: number;
  sourceControlY: number;
  targetControlX: number;
  targetControlY: number;
}): [number, number] {
  /*
   * cubic bezier t=0.5 mid point, not the actual mid point, but easy to calculate
   * https://stackoverflow.com/questions/67516101/how-to-find-distance-mid-point-of-bezier-curve
   */
  const centerX =
    sourceX * END_WEIGHT +
    sourceControlX * CONTROL_WEIGHT +
    targetControlX * CONTROL_WEIGHT +
    targetX * END_WEIGHT;
  const centerY =
    sourceY * END_WEIGHT +
    sourceControlY * CONTROL_WEIGHT +
    targetControlY * CONTROL_WEIGHT +
    targetY * END_WEIGHT;
  return [centerX, centerY];
}

function calculateControlOffset(distance: number, curvature: number): number {
  if (distance >= 0) {
    return HALF * distance;
  }

  return curvature * CURVATURE_SCALE * Math.sqrt(-distance);
}

export function getControlWithCurvature({
  pos,
  x1,
  y1,
  x2,
  y2,
  c,
}: {
  pos: Position;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  c: number;
}): [number, number] {
  switch (pos) {
    case "left":
      return [x1 - calculateControlOffset(x1 - x2, c), y1];
    case "right":
      return [x1 + calculateControlOffset(x2 - x1, c), y1];
    case "top":
      return [x1, y1 - calculateControlOffset(y1 - y2, c)];
    case "bottom":
      return [x1, y1 + calculateControlOffset(y2 - y1, c)];
  }
}
