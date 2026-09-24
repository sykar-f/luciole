import type { ReactNode } from "react";
import { color } from "./theme";

// Pure presentation shared by the Server page and the local loading screen: both use
// the same frame, so nothing moves when the Server answers.

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

/** The chat screen: a one-line model header, the transcript, then the composer. */
export function ChatFrame({
  header,
  children,
  composer,
}: {
  header: ReactNode;
  children: ReactNode;
  composer: ReactNode;
}) {
  return (
    <box flexDirection="column" flexGrow={1} gap={1}>
      <box id="chat-header" height={1} flexShrink={0}>
        {header}
      </box>
      <box id="chat-body" flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
        {children}
      </box>
      <box flexDirection="column" flexShrink={0}>
        {composer}
      </box>
    </box>
  );
}
