"use client";
import { KeyHelp, useConnection, type LayoutProps } from "airtty/client";
import { color } from "@airtty/harness/ui/theme";

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
      <box id="studio-help" height={1} flexShrink={0} paddingX={1} flexDirection="row" gap={2}>
        <text flexShrink={0} fg={color.muted}>
          <span fg={color.accent}>Ctrl+O</span> o app · p full · u undo · d diff · h revisions · r
          restart
        </text>
        <KeyHelp
          inline
          groups={["dialog", "studio", "global", "airtty"]}
          fg={color.muted}
          accent={color.accent}
        />
      </box>
    </box>
  );
}
