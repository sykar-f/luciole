"use client";
import { KeyHelp, useConnection, type LayoutProps } from "luciole/client";
import { color } from "@luciole/harness/ui/theme";

export default function RootLayout({ children }: LayoutProps) {
  const { error, buildError } = useConnection();
  return (
    <box flexDirection="column" flexGrow={1} paddingX={1}>
      {buildError || error ? (
        <text height={1} flexShrink={0} wrapMode="none" truncate fg={color.warn}>
          {buildError || error}
        </text>
      ) : null}
      <box flexDirection="column" flexGrow={1}>
        {children}
      </box>
      <box id="coder-help" height={1} flexShrink={0} paddingX={1}>
        <KeyHelp
          inline
          groups={["dialog", "picker", "coder", "browse", "global", "luciole"]}
          fg={color.muted}
          accent={color.accent}
        />
      </box>
    </box>
  );
}
