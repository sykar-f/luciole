"use client";
import type { LayoutProps } from "luciole/client";
import { Mux } from "../components/Mux";

// The panes live in the root layout: they persist for the whole session, whatever the
// page shows.
export default function RootLayout({ children }: LayoutProps) {
  return <Mux>{children}</Mux>;
}
