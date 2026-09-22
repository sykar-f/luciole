import { forge, slow } from "../server/instance";
import { Line } from "./frames";
import { ago, color } from "./theme";

// Async Server Component behind a Suspense boundary: the inbox is usable before the
// audit trail, which is deliberately slow, streams in.
export async function Activity() {
  await slow(4);
  const now = forge.now();
  return (
    <box id="activity" flexDirection="column" flexShrink={0}>
      {forge.activity(6).map((event, i) => (
        <Line key={i} fg={color.muted}>
          {ago(event.at, now).padEnd(12)} @{event.actor} {event.action} {event.target}
        </Line>
      ))}
    </box>
  );
}
