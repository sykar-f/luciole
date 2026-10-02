"use client";
import type { LoadingProps } from "@luciole-sh/core/client";
import { Column, DocFrame, SkeletonRows } from "../components/frames";
import { Help } from "../components/Help";
import { Pulse } from "../components/Pulse";

// Same frame as the Reader: the title is the requested path, the body pulses locally.
export default function DocLoading({ params }: LoadingProps) {
  return (
    <DocFrame
      title={params.path ?? "Opening…"}
      subtitle="Loading…"
      help={<Help groups={["luciole"]} />}
    >
      <Pulse>
        <Column>
          <SkeletonRows count={6} />
        </Column>
      </Pulse>
    </DocFrame>
  );
}
