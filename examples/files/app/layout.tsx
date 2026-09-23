"use client";
import { KeyHelp, useBindings, useConnection, type LayoutProps } from "airtty/client";

export default function RootLayout({ children }: LayoutProps) {
  const { status, error, activity, refresh } = useConnection();
  useBindings(
    () => ({
      bindings: [{ key: "ctrl+r", cmd: () => void refresh(), desc: "refresh", group: "global" }],
    }),
    [refresh],
  );
  return (
    <box flexDirection="column" flexGrow={1} padding={1} gap={1}>
      <text id="files-heading" height={1} flexShrink={0} wrapMode="none" truncate fg="#67d9bc">
        TERMINAL / FILES · {status}
        {activity === "refresh" ? " · Refreshing…" : ""}
        {activity === "navigate" ? " · Esc cancel" : ""}
      </text>
      {error ? <text fg="#ffbc66">{error}</text> : null}
      <box flexDirection="column" flexGrow={1}>
        {children}
      </box>
      <box id="files-footer" height={1} flexShrink={0}>
        <KeyHelp inline groups={["global", "airtty"]} />
      </box>
    </box>
  );
}
