import type { ReactNode } from "react";
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <box flexDirection="column" flexGrow={1}>
      {children}
    </box>
  );
}
