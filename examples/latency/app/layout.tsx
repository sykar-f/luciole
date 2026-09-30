"use client";
import { useBindings, useConnection, type LayoutProps } from "luciole/client";

export default function Layout({ children }: LayoutProps) {
  const { status, activity, refresh } = useConnection();
  useBindings(
    () => ({ bindings: [{ key: "ctrl+r", cmd: () => void refresh(), desc: "refresh" }] }),
    [refresh],
  );
  return (
    <box flexDirection="column" flexGrow={1} padding={1} gap={1}>
      <text id="latency-heading" height={1} flexShrink={0} wrapMode="none" truncate fg="#67d9bc">
        TERMINAL / LATENCY · {status}
        {activity === "refresh" ? " · Refreshing…" : ""}
      </text>
      <box flexDirection="column" flexGrow={1}>
        {children}
      </box>
    </box>
  );
}
