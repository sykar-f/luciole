import type { ReactNode } from "react";
import { Line } from "./Line";
import { color } from "./theme";

// Pure presentation shared by the agent screen and its loading state: same rows, same
// boxes, so nothing moves when the Server answers.
export function Frame({
  title,
  subtitle,
  status,
  prompt,
  promptFocused = false,
  children,
}: {
  title: ReactNode;
  subtitle: ReactNode;
  status: ReactNode;
  prompt: ReactNode;
  promptFocused?: boolean;
  children: ReactNode;
}) {
  return (
    <box flexDirection="column" flexGrow={1}>
      <Line id="agent-title" fg={color.accent}>
        {title}
      </Line>
      <Line id="agent-subtitle" fg={color.muted}>
        {subtitle}
      </Line>
      <box
        id="conversation"
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        border
        borderColor={color.border}
        title=" conversation "
        overflow="hidden"
      >
        {children}
      </box>
      <box id="agent-status" height={1} flexShrink={0} flexDirection="row" paddingX={1}>
        {status}
      </box>
      <box
        id="prompt"
        height={3}
        flexShrink={0}
        flexDirection="row"
        border
        borderColor={promptFocused ? color.accentDim : color.border}
        paddingX={1}
      >
        <text width={2} flexShrink={0} fg={promptFocused ? color.accent : color.faint}>
          ›
        </text>
        <box flexGrow={1}>{prompt}</box>
      </box>
    </box>
  );
}
