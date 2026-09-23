import { forge, slow } from "../server/instance";
import { Line } from "./frames";
import { ago, color } from "./theme";

const SLOWNESS = 4,
  EVENTS = 6,
  AGE_WIDTH = 12;
// Async Server Component behind a Suspense boundary: the inbox is usable before the
// audit trail, which is deliberately slow, streams in.
export async function Activity() {
  await slow(SLOWNESS);
  const now = forge.now();
  return (
    <box id="activity" flexDirection="column" flexShrink={0}>
      {forge.activity(EVENTS).map((event, i) => (
        <Line key={i} fg={color.muted}>
          {ago(event.at, now).padEnd(AGE_WIDTH)} @{event.actor} {event.action} {event.target}
        </Line>
      ))}
    </box>
  );
}
