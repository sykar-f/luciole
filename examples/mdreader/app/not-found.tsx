"use client";
import type { NotFoundProps } from "@luciole-sh/core/client";
import { Column, DocFrame, Line } from "../components/frames";
import { Help } from "../components/Help";
import { color } from "../components/theme";

// The document was removed or renamed, or the path is not a Markdown file of the library.
export default function Missing({ what, path }: NotFoundProps) {
  return (
    <DocFrame title={what ?? path} subtitle="Not found" help={<Help groups={["library"]} />}>
      <Column>
        <Line fg={color.warn}>This document is not in the library (removed or renamed?).</Line>
        <Line fg={color.muted}>Pick another one on the left, or press / to find one.</Line>
      </Column>
    </DocFrame>
  );
}
