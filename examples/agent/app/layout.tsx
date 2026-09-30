"use client";
import { KeyHelp, useConnection, type LayoutProps } from "luciole/client";
import { color } from "../components/theme";

export default function RootLayout({ children }: LayoutProps) {
  const { status, error, activity } = useConnection();
  return (
    <box flexDirection="column" flexGrow={1} padding={1} gap={1}>
      <text id="agent-heading" height={1} flexShrink={0} wrapMode="none" truncate fg={color.accent}>
        TERMINAL / AGENT · {status}
        {activity === "refresh" ? " · Refreshing…" : ""}
        {activity === "navigate" ? " · Esc cancel" : ""}
      </text>
      {error ? <text fg={color.warn}>{error}</text> : null}
      <box flexDirection="column" flexGrow={1}>
        {children}
      </box>
      <box id="agent-footer" height={1} flexShrink={0}>
        <KeyHelp
          inline
          groups={["agent", "global", "luciole"]}
          fg={color.muted}
          accent={color.accent}
        />
      </box>
    </box>
  );
}
