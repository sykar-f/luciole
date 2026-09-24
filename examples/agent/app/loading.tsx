"use client";
import { Frame } from "../components/Frame";
import { Line } from "../components/Line";
import { Pulse } from "../components/Pulse";
import { color } from "../components/theme";

// Same frame as the agent screen: the conversation box and the prompt stay in place.
export default function AgentLoading() {
  return (
    <Frame
      title="AGENT"
      subtitle="Connecting to the Server…"
      status={<text fg={color.faint}>● waiting</text>}
      prompt={<text fg={color.faint}>Ask the agent (Enter sends)</text>}
    >
      <Pulse>
        <box flexDirection="column" paddingX={1} paddingY={1}>
          <Line fg={color.skeleton}>▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒</Line>
          <Line />
          <Line fg={color.skeleton}>▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒</Line>
          <Line fg={color.skeleton}>▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒</Line>
        </box>
      </Pulse>
    </Frame>
  );
}
