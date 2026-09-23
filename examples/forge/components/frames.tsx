import type { ReactNode } from "react";
import { color } from "./theme";

// Pure presentation shared by Server pages and local loading screens. A screen and its
// loading state use the same frame, so nothing moves when the Server answers.

/** One fixed-height, truncated line: long Server text never pushes the layout. */
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

export function Screen({
  title,
  subtitle,
  status,
  help,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  status?: ReactNode;
  help: ReactNode;
  children: ReactNode;
}) {
  return (
    <box flexDirection="column" flexGrow={1} gap={1}>
      <box flexDirection="column" flexShrink={0}>
        <Line id="screen-title" fg={color.accent}>
          {title}
        </Line>
        <Line id="screen-subtitle" fg={color.muted}>
          {subtitle}
        </Line>
      </box>
      <box id="screen-body" flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
        {children}
      </box>
      <box flexDirection="column" flexShrink={0}>
        <Line id="screen-status" fg={color.warn}>
          {status}
        </Line>
        <box id="screen-help" height={1} flexShrink={0}>
          {help}
        </box>
      </box>
    </box>
  );
}

/** Static skeleton rows; a Client loading screen animates their container. */
export function SkeletonRows({ count, width = 48 }: { count: number; width?: number }) {
  return (
    <box flexDirection="column" flexShrink={0}>
      {Array.from({ length: count }, (_, i) => (
        <Line key={i} fg={color.skeleton}>
          {"▒".repeat(Math.max(8, width - ((i * 7) % 19)))}
        </Line>
      ))}
    </box>
  );
}
