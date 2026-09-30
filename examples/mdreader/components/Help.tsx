"use client";
import { KeyHelp } from "luciole/client";
import { color } from "./theme";

// A help line generated from the keymap layers mounted right now: the keys, and whether
// they are active (the finder turns the letters off), belong to their components.
export function Help({ groups }: { groups: readonly string[] }) {
  return <KeyHelp inline groups={groups} fg={color.muted} accent={color.accent} />;
}
