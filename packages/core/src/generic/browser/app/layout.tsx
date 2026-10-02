"use client";
import type { LayoutProps } from "@luciole-sh/core/client";
import { Browser } from "../components/Browser";

// The tabs live in the root layout: they persist for the whole session.
export default function RootLayout({ children }: LayoutProps) {
  return <Browser>{children}</Browser>;
}
