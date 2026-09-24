"use client";
import type { LayoutProps } from "airtty/client";
import { LibraryChrome } from "../components/Library";

// Persistent for the whole session: the library, its filter and the file watch survive
// navigation between documents; only the document pane is replaced.
export default function RootLayout({ children }: LayoutProps) {
  return <LibraryChrome>{children}</LibraryChrome>;
}
