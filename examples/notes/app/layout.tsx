import type { ReactNode } from "react";
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <box flexDirection="column" gap={1} flexGrow={1}>
      <text fg="#8b98a5">Personal notebook · SQLite on Server</text>
      {children}
    </box>
  );
}
