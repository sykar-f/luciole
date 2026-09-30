import { createContext, useContext } from "react";
import type { Role } from "./raster";

/** The canvas's colors, as `#rrggbb`. `<Flow theme>` overrides any of them. */
export type FlowTheme = {
  text: string;
  muted: string;
  border: string;
  selected: string;
  /** A node proposed as the target of a connection, and the connection's line. */
  connect: string;
  group: string;
  edge: string;
  animated: string;
  label: string;
  labelBg: string;
  marker: string;
  background: string;
  handle: string;
  panelBg: string;
};

export const defaultTheme: FlowTheme = {
  text: "#e6edf3",
  muted: "#8b98a5",
  border: "#4d5966",
  selected: "#67d9bc",
  connect: "#f2cc60",
  group: "#3b4450",
  edge: "#6e7c8a",
  animated: "#79c0ff",
  label: "#c9d1d9",
  labelBg: "#1f262e",
  marker: "#8b98a5",
  background: "#2d353e",
  handle: "#f2cc60",
  panelBg: "#161b22",
};

export const ThemeContext = createContext<FlowTheme>(defaultTheme);
export const useFlowTheme = () => useContext(ThemeContext);

/** The color a grid cell of `role` is drawn in. */
export function roleColor(theme: FlowTheme, role: Role): string {
  switch (role) {
    case "edge":
      return theme.edge;
    case "selected":
      return theme.selected;
    case "animated":
      return theme.animated;
    case "label":
      return theme.label;
    case "marker":
      return theme.marker;
    case "background":
      return theme.background;
    case "handle":
      return theme.handle;
  }
}
