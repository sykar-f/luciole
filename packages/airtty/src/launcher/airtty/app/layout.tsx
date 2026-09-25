"use client";
import { KeyHelp, useConnection, type LayoutProps } from "airtty/client";
import { color } from "../components/theme";

export default function RootLayout({ children }: LayoutProps) {
  const { status, error } = useConnection();
  return (
    <box flexDirection="column" flexGrow={1} padding={1} gap={1}>
      <text
        id="launcher-heading"
        height={1}
        flexShrink={0}
        wrapMode="none"
        truncate
        fg={color.accent}
      >
        AIRTTY · {status}
      </text>
      {error ? <text fg={color.warn}>{error}</text> : null}
      <box flexDirection="column" flexGrow={1}>
        {children}
      </box>
      <box height={1} flexShrink={0}>
        <KeyHelp inline groups={["launcher", "airtty"]} />
      </box>
    </box>
  );
}
