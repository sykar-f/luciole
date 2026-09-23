"use client";
import { useRouterState } from "airtty/client";
import { Line, Screen, SkeletonRows } from "../components/frames";
import { Help } from "../components/Help";
import { Pulse } from "../components/Pulse";
import { color } from "../components/theme";

// Same frame as the directory page: filter row, list column, preview pane. Only the
// skeleton pulses; the layout does not move when the listing arrives.
export default function DirectoryLoading() {
  const dir = useRouterState({ select: (s) => s.location.search.dir });
  return (
    <Screen
      title={`Opening ${typeof dir === "string" && dir ? dir : "root"}…`}
      subtitle="Reading the directory on the Server · Esc cancels"
      help={<Help groups={["airtty"]} />}
    >
      <box flexDirection="column" flexGrow={1} gap={1}>
        <Line fg={color.muted}>/ filter</Line>
        <box flexDirection="row" flexGrow={1} gap={1}>
          <box width={40} flexShrink={0} border borderColor={color.border} flexDirection="column">
            <Pulse>
              <SkeletonRows count={12} width={30} />
            </Pulse>
          </box>
          <box flexGrow={1} border borderColor={color.border} />
        </box>
        <Line />
      </box>
    </Screen>
  );
}
