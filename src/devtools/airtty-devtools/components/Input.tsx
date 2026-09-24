"use client";
import { useDevtools } from "./store";
import { clock, color, Line } from "./ui";

/** The keys the application received, newest first: which key did what, and when. */
const SHOWN = 40;
export function InputPanel() {
  const store = useDevtools();
  const keys = store.session.keys().slice(-SHOWN).toReversed();
  if (!keys.length) return <Line fg={color.faint}>No key pressed in the application yet.</Line>;
  return (
    <box flexDirection="column" flexGrow={1} overflow="hidden">
      <Line fg={color.muted}>Keys the application received (newest first)</Line>
      {keys.map((key, i) => (
        <Line key={`${key.at}:${i}`}>
          <span fg={color.faint}>{`${clock(key.at)} `}</span>
          <span fg={color.accent}>
            {[key.ctrl && "ctrl", key.meta && "meta", key.shift && "shift", key.name]
              .filter(Boolean)
              .join("+")}
          </span>
          <span fg={color.faint}>{`  ${JSON.stringify(key.sequence)}`}</span>
        </Line>
      ))}
    </box>
  );
}
