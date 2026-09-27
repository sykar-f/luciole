"use client";
import { Frame, Skeleton } from "@airtty/harness/ui/Frame";
import { Line } from "@airtty/harness/ui/Line";
import { Pulse } from "@airtty/harness/ui/Pulse";
import { color } from "@airtty/harness/ui/theme";

// The session screen's frame, while the Server renders it: nothing moves when it answers.
export default function SessionLoading() {
  return (
    <Frame
      header={<Line fg={color.muted}>◌ coder · connecting to the Server…</Line>}
      composer={<text fg={color.faint}>Message…</text>}
      status={<text fg={color.faint}>● waiting</text>}
    >
      <Pulse>
        <box flexDirection="column" paddingX={1} paddingY={1}>
          <Skeleton width={36} />
          <Line />
          <Skeleton width={52} />
          <Skeleton width={26} />
        </box>
      </Pulse>
    </Frame>
  );
}
