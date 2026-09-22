"use client";
import type { LayoutProps } from "@terminal/framework/client";
export default function Layout({ children }: LayoutProps) {
  return (
    <box flexDirection="column" flexGrow={1}>
      {children}
    </box>
  );
}
