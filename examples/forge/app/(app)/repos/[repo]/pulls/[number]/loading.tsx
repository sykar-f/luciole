"use client";
import type { LoadingProps } from "luciole/client";
import { Screen, SkeletonRows } from "../../../../../../components/frames";
import { Help } from "../../../../../../components/Help";
import { Pulse } from "../../../../../../components/Pulse";

// The files tab shows more skeleton rows than the others, like its real content.
const FILE_ROWS = 14,
  TAB_ROWS = 8;
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
      help={<Help groups={["luciole"]} />}
    >
      <Pulse>
        <SkeletonRows count={tab === "files" ? FILE_ROWS : TAB_ROWS} width={72} />
      </Pulse>
    </Screen>
  );
}
