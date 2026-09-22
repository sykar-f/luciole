"use client";
import type { LayoutProps } from "airtty/client";
import { AppChrome } from "../../components/AppChrome";

// Persistent for every signed-in screen: sidebar, identity, Drafts and keymap survive
// navigation. Leaving the group (sign out) unmounts it.
export default function SignedInLayout({ children }: LayoutProps) {
  return <AppChrome>{children}</AppChrome>;
}
