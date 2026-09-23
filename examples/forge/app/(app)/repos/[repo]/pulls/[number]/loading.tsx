"use client";
import type { LoadingProps } from "airtty/client";
import { Screen, SkeletonRows } from "../../../../../../components/frames";
import { Help } from "../../../../../../components/Help";
import { Pulse } from "../../../../../../components/Pulse";

// Shared by the three tabs: same frame as the pages, only the body pulses.
export default function PullLoading({ params, path }: LoadingProps) {
  const tab = path.endsWith("/files")
    ? "files"
    : path.endsWith("/checks")
      ? "checks"
      : "conversation";
  return (
    <Screen
      title={`#${params.number ?? ""} · loading ${tab}…`}
      subtitle="Waiting for Server… · the tabs and your review progress stay mounted"
      help={<Help groups={["airtty"]} />}
    >
      <Pulse>
        <SkeletonRows count={tab === "files" ? 14 : 8} width={72} />
      </Pulse>
    </Screen>
  );
}
