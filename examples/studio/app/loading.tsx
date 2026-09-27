"use client";
import { Line } from "@airtty/harness/ui/Line";
import { Pulse } from "@airtty/harness/ui/Pulse";
import { color } from "@airtty/harness/ui/theme";

// The screen's frame while the Server renders it: nothing moves when it answers.
export default function StudioLoading() {
  return (
    <box flexDirection="column" flexGrow={1}>
      <Line fg={color.muted}>◌ studio · connecting to the Server…</Line>
      <Pulse>
        <box flexDirection="row" flexGrow={1} gap={1}>
          <box flexGrow={1} flexBasis={0} border borderStyle="rounded" borderColor={color.border} />
          <box flexGrow={1} flexBasis={0} border borderStyle="rounded" borderColor={color.border} />
        </box>
      </Pulse>
    </box>
  );
}
