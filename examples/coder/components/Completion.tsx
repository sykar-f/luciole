"use client";
import { color } from "./theme";

export type Suggestion = { value: string; label: string; detail?: string };
// Rows of the popup; more matches are reached by typing.
export const COMPLETION_ROWS = 8;

/**
 * Suggestions for the word being typed (`/command`, `@file`), just above the composer.
 * Drawn under the frame's root: absolute positions are relative to the parent (#1512).
 */
export function Completion({
  suggestions,
  cursor,
  bottom,
  onPick,
}: {
  suggestions: readonly Suggestion[];
  cursor: number;
  /** Rows from the bottom of the frame: the composer's and the status line's. */
  bottom: number;
  onPick: (suggestion: Suggestion) => void;
}) {
  if (!suggestions.length) return null;
  const rows = suggestions.slice(0, COMPLETION_ROWS);
  return (
    <box
      id="completion"
      position="absolute"
      left={2}
      bottom={bottom}
      width="60%"
      height={rows.length + 2}
      zIndex={50}
      flexDirection="column"
      border
      borderColor={color.border}
      backgroundColor={color.overlay}
    >
      {rows.map((s, i) => (
        <box
          key={s.value}
          height={1}
          flexDirection="row"
          backgroundColor={i === cursor ? color.selected : undefined}
          onMouseDown={() => onPick(s)}
        >
          <text flexShrink={0} fg={color.accent}>
            {s.label}
          </text>
          <text flexGrow={1} wrapMode="none" truncate fg={color.muted}>
            {s.detail ? `  ${s.detail}` : ""}
          </text>
        </box>
      ))}
    </box>
  );
}
