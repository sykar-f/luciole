"use client";
import { useConnection, type LayoutProps } from "airtty/client";

// The frame every page shares: the app's name and whether its Server answers.
export default function Layout({ children }: LayoutProps) {
  const { status } = useConnection();
  return (
    <box flexDirection="column" flexGrow={1} padding={1} gap={1}>
      <text id="app-status" height={1} flexShrink={0} wrapMode="none" truncate fg="#67d9bc">
        MY APP · {status}
      </text>
      <box flexDirection="column" flexGrow={1}>
        {children}
      </box>
    </box>
  );
}
