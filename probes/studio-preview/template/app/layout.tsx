"use client";
import { useConnection, type LayoutProps } from "luciole/client";

// The chrome studio's template keeps: the connection state and, in development, the
// last build error (sent by `luciole dev`), so a failed rebuild shows over the last good
// screen instead of replacing it.
export default function Layout({ children }: LayoutProps) {
  const { status, buildError } = useConnection();
  return (
    <box flexDirection="column" flexGrow={1} padding={1} gap={1}>
      <text id="studio-status" height={1} flexShrink={0} wrapMode="none" truncate fg="#67d9bc">
        STUDIO APP · {status}
      </text>
      {buildError ? (
        <text id="studio-build-error" flexShrink={0} fg="#ff6b6b">
          {buildError}
        </text>
      ) : null}
      <box flexDirection="column" flexGrow={1}>
        {children}
      </box>
    </box>
  );
}
