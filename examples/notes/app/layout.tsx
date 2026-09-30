"use client";
import { useState } from "react";
import {
  DebugOverlay,
  KeyHelp,
  useBindings,
  useConnection,
  type LayoutProps,
} from "luciole/client";
import { NotebookLayout } from "../components/NoteFrame";

// The application's chrome: connection state and the refresh key are Notes' choices,
// read from the framework through useConnection().
export default function Layout({ children }: LayoutProps) {
  const { status, error, activity, refresh } = useConnection();
  const [debug, setDebug] = useState(false);
  useBindings(
    () => ({
      bindings: [
        { key: "ctrl+r", cmd: () => void refresh(), desc: "reconnect", group: "global" },
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
      <text id="notes-heading" height={1} flexShrink={0} wrapMode="none" truncate fg="#67d9bc">
        TERMINAL / NOTES · {status}
        {activity === "refresh" ? " · Refreshing…" : ""}
        {activity === "navigate" ? " · Esc cancel" : ""}
      </text>
      {error ? <text fg="#ffbc66">{error}</text> : null}
      {debug ? <DebugOverlay /> : null}
      <NotebookLayout>{children}</NotebookLayout>
      <box id="notes-footer" height={1} flexShrink={0}>
        <KeyHelp inline groups={["global", "luciole"]} />
      </box>
    </box>
  );
}
