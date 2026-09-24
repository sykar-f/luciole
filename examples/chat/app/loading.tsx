"use client";
import { ChatFrame, Line } from "../components/frames";
import { Pulse } from "../components/Pulse";
import { color } from "../components/theme";

// Skeleton lines of the welcome text.
const WELCOME_WIDTH = 42,
  DETAILS_WIDTH = 28;
const SKELETON = [WELCOME_WIDTH, DETAILS_WIDTH] as const;

// Shown while the Server looks the model up (its price comes from OpenRouter's model
// list). Same frame as the chat, so nothing moves when it arrives.
export default function ChatLoading() {
  return (
    <ChatFrame
      header={<Line fg={color.muted}>Looking up the model…</Line>}
      composer={
        <box border borderColor={color.border} height={3} flexShrink={0} title=" message " />
      }
    >
      <Pulse>
        {SKELETON.map((width) => (
          <Line key={width} fg={color.skeleton}>
            {"▒".repeat(width)}
          </Line>
        ))}
      </Pulse>
    </ChatFrame>
  );
}
