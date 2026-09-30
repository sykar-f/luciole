"use client";
import type { LayoutProps } from "luciole/client";
import { PullChrome } from "../../../../../../components/PullChrome";

export default function PullLayout({ children, params }: LayoutProps) {
  return (
    <PullChrome repo={params.repo ?? ""} number={params.number ?? ""}>
      {children}
    </PullChrome>
  );
}
