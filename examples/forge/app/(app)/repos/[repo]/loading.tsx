"use client";
import type { LoadingProps } from "airtty/client";
import { Screen, SkeletonRows } from "../../../../components/frames";
import { Help } from "../../../../components/Help";
import { Pulse } from "../../../../components/Pulse";

export default function RepoLoading({ params }: LoadingProps) {
  return (
    <Screen
      title={params.repo ?? "Repository"}
      subtitle="Loading…"
      help={<Help groups={["airtty"]} />}
    >
      <Pulse>
        <SkeletonRows count={8} width={70} />
      </Pulse>
    </Screen>
  );
}
