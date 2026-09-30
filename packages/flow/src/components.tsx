import { useEffect, useRef, type ReactNode } from "react";
import { RGBA, type BoxRenderable, type MouseEvent, type OptimizedBuffer } from "@opentui/core";
import { absolutePositions, flowBounds, toFlow } from "./geometry";
import { useStore, useStoreVersion } from "./hooks";
import { drawMiniMap, Grid, type BackgroundVariant, type Role } from "./raster";
import { roleColor, useFlowTheme } from "./theme";
import type { Rect, XY } from "./types";

const PANEL_Z = 100_000;
const DEFAULT_GAP: XY = { x: 8, y: 4 };
const MINIMAP_WIDTH = 24;
const MINIMAP_HEIGHT = 8;

/** Marks every `gap` flow cells, under the edges: dots, grid lines, or crosses. */
export function Background({
  variant = "dots",
  gap = DEFAULT_GAP,
  color,
}: {
  variant?: BackgroundVariant;
  gap?: XY;
  color?: string;
}) {
  const store = useStore();
  const { x, y } = gap;
  useEffect(() => {
    store.setBackground({ variant, gap: { x, y }, color });
    return () => store.setBackground(null);
  }, [store, variant, x, y, color]);
  return null;
}

export type PanelPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

/** Content over the canvas, in a corner or centered on an edge. */
export function Panel({
  position = "top-left",
  children,
}: {
  position?: PanelPosition;
  children: ReactNode;
}) {
  const [vertical, horizontal] = position.split("-");
  const place = {
    ...(vertical === "top" ? { top: 0 } : { bottom: 0 }),
    ...(horizontal === "left"
      ? { left: 0 }
      : horizontal === "right"
        ? { right: 0 }
        : { left: 0, right: 0, alignItems: "center" as const }),
  };
  // A click on a panel is its own: it neither selects nor pans the canvas.
  return (
    <box
      position="absolute"
      zIndex={PANEL_Z}
      flexDirection="column"
      {...place}
      onMouseDown={(event: MouseEvent) => event.stopPropagation()}
    >
      {children}
    </box>
  );
}

/** Zoom in, zoom out, fit, and the current level. */
export function Controls({ position = "bottom-left" }: { position?: PanelPosition }) {
  const store = useStoreVersion();
  const theme = useFlowTheme();
  const button = (label: string, action: () => void) => (
    <text
      selectable={false}
      fg={theme.text}
      bg={theme.labelBg}
      onMouseDown={(event: MouseEvent) => {
        event.stopPropagation();
        action();
      }}
    >
      {` ${label} `}
    </text>
  );
  return (
    <Panel position={position}>
      <box flexDirection="row" gap={1} backgroundColor={theme.panelBg}>
        {button("+", () => store.zoom(1))}
        {button("-", () => store.zoom(-1))}
        {button("fit", () => store.fitView())}
        <text selectable={false} fg={theme.muted}>
          {store.detail}
        </text>
      </box>
    </Panel>
  );
}

/**
 * Every node in braille, and the part in view outlined. A click moves the view there.
 */
export function MiniMap({
  position = "bottom-right",
  width = MINIMAP_WIDTH,
  height = MINIMAP_HEIGHT,
}: {
  position?: PanelPosition;
  width?: number;
  height?: number;
}) {
  const store = useStoreVersion();
  const theme = useFlowTheme();
  const box = useRef<BoxRenderable>(null);
  const grid = new Grid(width, height);
  const view: Rect = (() => {
    const topLeft = toFlow({ x: 0, y: 0 }, store.viewport);
    return {
      ...topLeft,
      width: store.size.width / store.viewport.zoom,
      height: store.size.height / store.viewport.zoom,
    };
  })();
  const nodes = flowBounds(store.nodes, store.measured) ?? view;
  // The world: every node and the view.
  const x0 = Math.min(nodes.x, view.x);
  const y0 = Math.min(nodes.y, view.y);
  const world = {
    x: x0,
    y: y0,
    width: Math.max(nodes.x + nodes.width, view.x + view.width) - x0,
    height: Math.max(nodes.y + nodes.height, view.y + view.height) - y0,
  };
  const positions = absolutePositions(store.nodes);
  const rects = store.nodes
    .filter((n) => !n.hidden && n.type !== "group")
    .map((n) => {
      const position = positions.get(n.id) ?? n.position;
      const one = flowBounds([{ ...n, parentId: undefined, position }], store.measured);
      const role: Role = n.selected ? "selected" : "edge";
      return {
        rect: one ?? { x: 0, y: 0, width: 0, height: 0 },
        role,
        color: n.selected ? undefined : n.color,
      };
    });
  const toWorld = drawMiniMap(grid, world, rects, view);
  useEffect(() => {
    box.current?.requestRender();
  });
  return (
    <Panel position={position}>
      <box
        ref={box}
        width={width}
        height={height}
        backgroundColor={theme.panelBg}
        onMouseDown={(event: MouseEvent) => {
          event.stopPropagation();
          const at = box.current;
          if (!at) return;
          store.setCenter(toWorld({ x: event.x - at.x, y: event.y - at.y }));
        }}
        renderAfter={function (this: { x: number; y: number }, buffer: OptimizedBuffer) {
          for (const [x, y, cell] of grid.entries())
            buffer.setCellWithAlphaBlending(
              this.x + x,
              this.y + y,
              cell.char,
              RGBA.fromHex(cell.color ?? roleColor(theme, cell.role)),
              RGBA.fromHex(theme.panelBg),
            );
        }}
      />
    </Panel>
  );
}
