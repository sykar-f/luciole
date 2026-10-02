"use client";
import type { LayoutProps } from "@luciole-sh/core/client";
import { RepoChrome } from "../../../../components/RepoChrome";

export default function RepoLayout({ children, params }: LayoutProps) {
  return <RepoChrome repo={params.repo ?? ""}>{children}</RepoChrome>;
}
