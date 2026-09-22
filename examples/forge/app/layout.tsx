"use client";
import type { LayoutProps } from "airtty/client";

export default function RootLayout({ children }: LayoutProps) {
  return (
    <box flexDirection="column" flexGrow={1}>
      {children}
    </box>
  );
}
