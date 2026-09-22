"use client";
import type { LoadingProps } from "@terminal/framework/client";
import { Screen, SkeletonRows } from "../../../../components/frames";
import { Pulse } from "../../../../components/Pulse";

export default function RepoLoading({ params }: LoadingProps) {
  return (
    <Screen title={params.repo ?? "Repository"} subtitle="Loading…" help="Esc cancel">
      <Pulse>
        <SkeletonRows count={8} width={70} />
      </Pulse>
    </Screen>
  );
}
