import type { ReactNode } from "react";
import { color } from "./theme";

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
