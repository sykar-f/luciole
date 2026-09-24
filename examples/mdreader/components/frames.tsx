import type { ReactNode } from "react";
import { color } from "./theme";

// Pure presentation shared by Server pages and local loading screens: a document and
// its loading state use the same frame, so nothing moves when the Server answers.

/** One fixed-height, truncated line: long text never pushes the layout. */
export function Line({
  id,
  children,
  fg = color.text,
  bg,
}: {
  id?: string;
  children?: ReactNode;
  fg?: string;
  bg?: string;
}) {
  return (
    <text id={id} height={1} flexShrink={0} wrapMode="none" truncate fg={fg} bg={bg}>
      {children ?? ""}
    </text>
  );
}

/** Width of the reading column, centered in the pane as on the web (~80–90 characters). */
export const READING_WIDTH = 92;

/** The reading column: full width in a narrow pane, centered in a wide one. */
export function Column({ children }: { children: ReactNode }) {
  return (
    <box flexDirection="row" justifyContent="center" width="100%" flexShrink={0}>
      <box flexDirection="column" width="100%" maxWidth={READING_WIDTH} paddingRight={2}>
        {children}
      </box>
    </box>
  );
}

/** Title, subtitle, body, status line and key help of the document pane. */
export function DocFrame({
  title,
  subtitle,
  status,
  help,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  status?: ReactNode;
  help?: ReactNode;
  children: ReactNode;
}) {
  return (
    <box flexDirection="column" flexGrow={1} gap={1}>
      <Column>
        <Line id="doc-title" fg={color.accent}>
          {title}
        </Line>
        <Line id="doc-subtitle" fg={color.muted}>
          {subtitle}
        </Line>
      </Column>
      <box
        id="doc-body"
        flexDirection="row"
        justifyContent="center"
        flexGrow={1}
        flexShrink={1}
        overflow="hidden"
      >
        {children}
      </box>
      <box flexDirection="column" flexShrink={0}>
        <box id="doc-status" height={1} flexShrink={0} flexDirection="row">
          {status}
        </box>
        <box id="doc-help" height={1} flexShrink={0}>
          {help}
        </box>
      </box>
    </box>
  );
}

// Skeleton rows vary their length pseudo-randomly, never below `SKELETON_MIN`.
const SKELETON_MIN = 8,
  SKELETON_STEP = 7,
  SKELETON_SPREAD = 23;
/** Static skeleton rows; a Client loading screen animates their container. */
export function SkeletonRows({ count, width = 60 }: { count: number; width?: number }) {
  return (
    <box flexDirection="column" flexShrink={0} gap={1}>
      {Array.from({ length: count }, (_, i) => (
        <Line key={i} fg={color.skeleton}>
          {"▒".repeat(Math.max(SKELETON_MIN, width - ((i * SKELETON_STEP) % SKELETON_SPREAD)))}
        </Line>
      ))}
    </box>
  );
}
