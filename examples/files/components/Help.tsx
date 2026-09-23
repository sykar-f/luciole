"use client";
import { KeyHelp } from "airtty/client";
import { color } from "./theme";

// The help line of a screen, generated from the keymap layers mounted right now.
export function Help({ groups }: { groups: readonly string[] }) {
  return <KeyHelp inline groups={groups} fg={color.muted} accent={color.accent} />;
}
