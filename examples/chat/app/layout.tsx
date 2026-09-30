"use client";
import { useState } from "react";
import {
  DebugOverlay,
  KeyHelp,
  useBindings,
  useConnection,
  type LayoutProps,
} from "luciole/client";

export default function RootLayout({ children }: LayoutProps) {
  const { status, error, activity, refresh } = useConnection();
  const [debug, setDebug] = useState(false);
  useBindings(
    () => ({
      bindings: [
        { key: "ctrl+r", cmd: () => void refresh(), desc: "refresh", group: "global" },
        {
          key: "ctrl+t",
          cmd: () => setDebug((shown) => !shown),
          desc: "requests",
          group: "global",
        },
      ],
    }),
    [refresh],
  );
  return (
    <box flexDirection="column" flexGrow={1} padding={1} gap={1}>
      <text id="chat-heading" height={1} flexShrink={0} wrapMode="none" truncate fg="#67d9bc">
        TERMINAL / CHAT · {status}
        {activity === "refresh" ? " · Refreshing…" : ""}
      </text>
      {error ? <text fg="#ffbc66">{error}</text> : null}
      <box flexDirection="column" flexGrow={1}>
        {children}
      </box>
      {debug ? <DebugOverlay /> : null}
      <box id="chat-footer" height={1} flexShrink={0}>
        <KeyHelp inline groups={["global", "luciole"]} />
      </box>
    </box>
  );
}
