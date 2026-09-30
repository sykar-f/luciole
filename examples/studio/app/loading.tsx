"use client";
import { Line } from "@luciole/harness/ui/Line";
import { Pulse } from "@luciole/harness/ui/Pulse";
import { color } from "@luciole/harness/ui/theme";

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
