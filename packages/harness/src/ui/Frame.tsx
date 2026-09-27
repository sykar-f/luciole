import type { ReactNode } from "react";
import { Line } from "./Line";
import { color } from "./theme";

// Pure presentation shared by the session screen and its loading state: same rows, same
// boxes, so nothing moves when the Server answers.
export function Frame({
  header,
  plan,
  composer,
  composerHeight = 1,
  composerFocused = false,
  composerTitle,
  status,
  overlay,
  children,
}: {
  header: ReactNode;
  plan?: ReactNode;
  composer: ReactNode;
  /** Lines of text in the composer, borders excluded. */
  composerHeight?: number;
  composerFocused?: boolean;
  composerTitle?: string;
  status: ReactNode;
  /** Dialogs and pickers: drawn over everything, positioned against this root. */
  overlay?: ReactNode;
  children: ReactNode;
}) {
  return (
    <box id="coder" flexDirection="column" flexGrow={1}>
      <box id="coder-header" height={1} flexShrink={0} flexDirection="row">
        {header}
      </box>
      <box
        id="coder-transcript"
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        overflow="hidden"
      >
        {children}
      </box>
      {plan ? (
        <box id="coder-plan" height={1} flexShrink={0} flexDirection="row" paddingX={1}>
          {plan}
        </box>
      ) : null}
      <box
        id="composer"
        height={composerHeight + 2}
        flexShrink={0}
        flexDirection="row"
        border
        borderStyle="rounded"
        borderColor={composerFocused ? color.accentDim : color.border}
        title={composerTitle}
        paddingX={1}
      >
        <text width={2} flexShrink={0} fg={composerFocused ? color.accent : color.faint}>
          ›
        </text>
        <box flexGrow={1}>{composer}</box>
      </box>
      <box id="coder-status" height={1} flexShrink={0} flexDirection="row" paddingX={1}>
        {status}
      </box>
      {overlay}
    </box>
  );
}

/** A skeleton row of the loading state. */
export const Skeleton = ({ width }: { width: number }) => (
  <Line fg={color.skeleton}>{"▒".repeat(width)}</Line>
);
