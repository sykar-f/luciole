// Adapted from xyflow, packages/system/src/utils/edges/smoothstep-edge.ts (MIT, see LICENSE
// and README.md in this directory): `getPoints` only, returning the orthogonal path's
// corner points instead of an SVG path.
import type { Position, XY } from "../../types";
import { getEdgeCenter } from "./bezier";

const HALF = 0.5;

const handleDirections: Record<Position, XY> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
};

const getDirection = ({
  source,
  sourcePosition,
  target,
}: {
  source: XY;
  sourcePosition: Position;
  target: XY;
}): XY => {
  if (sourcePosition === "left" || sourcePosition === "right") {
    return source.x < target.x ? { x: 1, y: 0 } : { x: -1, y: 0 };
  }
  return source.y < target.y ? { x: 0, y: 1 } : { x: 0, y: -1 };
};

export type StepPoints = {
  /** From the source to the target, both included; consecutive points share an axis. */
  points: XY[];
  labelX: number;
  labelY: number;
};

/*
 * With this function we try to mimic an orthogonal edge routing behaviour
 * It's not as good as a real orthogonal edge routing, but it's faster and good enough as a default for step and smooth step edges
 */
export function getStepPoints({
  source,
  sourcePosition = "bottom",
  target,
  targetPosition = "top",
  center = {},
  offset,
  stepPosition = HALF,
}: {
  source: XY;
  sourcePosition?: Position;
  target: XY;
  targetPosition?: Position;
  center?: Partial<XY>;
  offset: number;
  stepPosition?: number;
}): StepPoints {
  const sourceDir = handleDirections[sourcePosition];
  const targetDir = handleDirections[targetPosition];
  const sourceGapped: XY = {
    x: source.x + sourceDir.x * offset,
    y: source.y + sourceDir.y * offset,
  };
  const targetGapped: XY = {
    x: target.x + targetDir.x * offset,
    y: target.y + targetDir.y * offset,
  };
  const dir = getDirection({ source: sourceGapped, sourcePosition, target: targetGapped });
  const dirAccessor = dir.x !== 0 ? "x" : "y";
  const currDir = dir[dirAccessor];

  let points: XY[];
  let centerX: number;
  let centerY: number;
  const sourceGapOffset = { x: 0, y: 0 };
  const targetGapOffset = { x: 0, y: 0 };

  // opposite handle positions, default case
  if (sourceDir[dirAccessor] * targetDir[dirAccessor] === -1) {
    if (dirAccessor === "x") {
      // Primary direction is horizontal, so stepPosition affects X coordinate
      centerX = center.x ?? sourceGapped.x + (targetGapped.x - sourceGapped.x) * stepPosition;
      centerY = center.y ?? (sourceGapped.y + targetGapped.y) / 2;
    } else {
      // Primary direction is vertical, so stepPosition affects Y coordinate
      centerX = center.x ?? (sourceGapped.x + targetGapped.x) / 2;
      centerY = center.y ?? sourceGapped.y + (targetGapped.y - sourceGapped.y) * stepPosition;
    }

    /*
     *    --->
     *    |
     * >---
     */
    const verticalSplit: XY[] = [
      { x: centerX, y: sourceGapped.y },
      { x: centerX, y: targetGapped.y },
    ];
    /*
     *    |
     *  ---
     *  |
     */
    const horizontalSplit: XY[] = [
      { x: sourceGapped.x, y: centerY },
      { x: targetGapped.x, y: centerY },
    ];

    if (sourceDir[dirAccessor] === currDir) {
      points = dirAccessor === "x" ? verticalSplit : horizontalSplit;
    } else {
      points = dirAccessor === "x" ? horizontalSplit : verticalSplit;
    }
  } else {
    // sourceTarget means we take x from source and y from target, targetSource is the opposite
    const sourceTarget: XY[] = [{ x: sourceGapped.x, y: targetGapped.y }];
    const targetSource: XY[] = [{ x: targetGapped.x, y: sourceGapped.y }];
    // this handles edges with same handle positions
    if (dirAccessor === "x") {
      points = sourceDir.x === currDir ? targetSource : sourceTarget;
    } else {
      points = sourceDir.y === currDir ? sourceTarget : targetSource;
    }

    if (sourcePosition === targetPosition) {
      const diff = Math.abs(source[dirAccessor] - target[dirAccessor]);

      // if an edge goes from right to right for example (sourcePosition === targetPosition) and the distance between source.x and target.x is less than the offset, the added point and the gapped source/target will overlap. This leads to a weird edge path. To avoid this we add a gapOffset to the source/target
      if (diff <= offset) {
        const gapOffset = Math.min(offset - 1, offset - diff);
        if (sourceDir[dirAccessor] === currDir) {
          sourceGapOffset[dirAccessor] =
            (sourceGapped[dirAccessor] > source[dirAccessor] ? -1 : 1) * gapOffset;
        } else {
          targetGapOffset[dirAccessor] =
            (targetGapped[dirAccessor] > target[dirAccessor] ? -1 : 1) * gapOffset;
        }
      }
    }

    // these are conditions for handling mixed handle positions like Right -> Bottom for example
    if (sourcePosition !== targetPosition) {
      const dirAccessorOpposite = dirAccessor === "x" ? "y" : "x";
      const isSameDir = sourceDir[dirAccessor] === targetDir[dirAccessorOpposite];
      const sourceGtTargetOppo =
        sourceGapped[dirAccessorOpposite] > targetGapped[dirAccessorOpposite];
      const sourceLtTargetOppo =
        sourceGapped[dirAccessorOpposite] < targetGapped[dirAccessorOpposite];
      const flipSourceTarget =
        (sourceDir[dirAccessor] === 1 &&
          ((!isSameDir && sourceGtTargetOppo) || (isSameDir && sourceLtTargetOppo))) ||
        (sourceDir[dirAccessor] !== 1 &&
          ((!isSameDir && sourceLtTargetOppo) || (isSameDir && sourceGtTargetOppo)));

      if (flipSourceTarget) {
        points = dirAccessor === "x" ? sourceTarget : targetSource;
      }
    }

    const sourceGapPoint = {
      x: sourceGapped.x + sourceGapOffset.x,
      y: sourceGapped.y + sourceGapOffset.y,
    };
    const targetGapPoint = {
      x: targetGapped.x + targetGapOffset.x,
      y: targetGapped.y + targetGapOffset.y,
    };
    const corner = points[0] ?? sourceGapPoint;
    const maxXDistance = Math.max(
      Math.abs(sourceGapPoint.x - corner.x),
      Math.abs(targetGapPoint.x - corner.x),
    );
    const maxYDistance = Math.max(
      Math.abs(sourceGapPoint.y - corner.y),
      Math.abs(targetGapPoint.y - corner.y),
    );

    // we want to place the label on the longest segment of the edge
    if (maxXDistance >= maxYDistance) {
      centerX = (sourceGapPoint.x + targetGapPoint.x) / 2;
      centerY = corner.y;
    } else {
      centerX = corner.x;
      centerY = (sourceGapPoint.y + targetGapPoint.y) / 2;
    }
  }

  const gappedSource = {
    x: sourceGapped.x + sourceGapOffset.x,
    y: sourceGapped.y + sourceGapOffset.y,
  };
  const gappedTarget = {
    x: targetGapped.x + targetGapOffset.x,
    y: targetGapped.y + targetGapOffset.y,
  };
  const first = points[0] ?? gappedSource;
  const last = points.at(-1) ?? gappedTarget;

  // Unlike the original, the default label center (getEdgeCenter) is only a fallback.
  const [defaultX, defaultY] = getEdgeCenter({
    sourceX: source.x,
    sourceY: source.y,
    targetX: target.x,
    targetY: target.y,
  });
  return {
    points: [
      source,
      // we only want to add the gapped source/target if they are different from the first/last point to avoid duplicates which can cause issues with the bends
      ...(gappedSource.x !== first.x || gappedSource.y !== first.y ? [gappedSource] : []),
      ...points,
      ...(gappedTarget.x !== last.x || gappedTarget.y !== last.y ? [gappedTarget] : []),
      target,
    ],
    labelX: Number.isFinite(centerX) ? centerX : defaultX,
    labelY: Number.isFinite(centerY) ? centerY : defaultY,
  };
}
