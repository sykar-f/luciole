"use client";
import { KeyHelp, useConnection, type LayoutProps } from "@luciole-sh/core/client";
import { color } from "../components/theme";

export default function RootLayout({ children }: LayoutProps) {
  const { error, buildError } = useConnection();
  return (
    <box flexDirection="column" flexGrow={1}>
      {buildError || error ? (
        <text height={1} flexShrink={0} wrapMode="none" truncate fg={color.failed}>
          {buildError || error}
        </text>
      ) : null}
      <box flexDirection="column" flexGrow={1}>
        {children}
      </box>
      <box height={1} flexShrink={0} paddingX={1}>
        <KeyHelp
          inline
          groups={["pipeline", "flow", "luciole"]}
          fg={color.muted}
          accent={color.accent}
        />
      </box>
    </box>
  );
}
