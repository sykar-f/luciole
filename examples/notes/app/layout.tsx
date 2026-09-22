"use client";
import type { LayoutProps } from "@terminal/framework/client";
import { NotebookLayout } from "../components/NoteFrame";

export default function Layout({ children }: LayoutProps) {
  return <NotebookLayout>{children}</NotebookLayout>;
}
