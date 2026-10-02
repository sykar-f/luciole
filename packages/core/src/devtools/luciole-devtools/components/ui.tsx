"use client";
import { useState, type ReactNode } from "react";
import { useBindings } from "@luciole-sh/core/client";

/** Shared look and list behaviour of the DevTools panels. */
export const color = {
  accent: "#67d9bc",
  text: "#d7dde3",
  muted: "#8b98a5",
  faint: "#4a5561",
  selected: "#233044",
  server: "#c792ea",
  client: "#82aaff",
  ok: "#8bd49c",
  warn: "#f0c060",
  error: "#ff6b6b",
  cache: "#f78c6c",
  router: "#c792ea",
  stream: "#56b6c2",
  flash: "#3d5a3a",
  fade: "#26372a",
} as const;

const SECOND = 1000,
  TEN_SECONDS = 10_000,
  MINUTE = 60_000,
  KIB = 1024,
  MS_DIGITS = 3,
  SHORT_ID = 8;
export const ms = (value: number | undefined) =>
  value === undefined
    ? "–"
    : value >= SECOND
      ? `${(value / SECOND).toFixed(value >= TEN_SECONDS ? 0 : 1)}s`
      : `${Math.round(value)}ms`;
export const bytes = (value: number) =>
  value >= KIB * KIB
    ? `${(value / KIB / KIB).toFixed(1)}M`
    : value >= KIB
      ? `${(value / KIB).toFixed(1)}K`
      : `${value}B`;
/** An age: "3s", "2m 5s". */
export const age = (from: number | undefined, now: number) => {
  if (from === undefined) return "–";
  const elapsed = Math.max(0, now - from);
  if (elapsed < MINUTE) return `${Math.floor(elapsed / SECOND)}s`;
  return `${Math.floor(elapsed / MINUTE)}m ${Math.floor((elapsed % MINUTE) / SECOND)}s`;
};
/** A clock time with milliseconds, local. */
export const clock = (at: number) => {
  const d = new Date(at);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), MS_DIGITS)}`;
};
export const fit = (text: string, width: number) =>
  text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width);
export const shortId = (callId: string | undefined) => (callId ? callId.slice(0, SHORT_ID) : "");

/** One line of text that never wraps. */
export function Line({
  children,
  fg = color.text,
  bg,
}: {
  children: ReactNode;
  fg?: string;
  bg?: string;
}) {
  return (
    <text height={1} flexShrink={0} wrapMode="none" truncate fg={fg} bg={bg}>
      {children}
    </text>
  );
}

/** A titled section of a panel. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <box flexDirection="column" flexShrink={0}>
      <Line fg={color.accent}>{title}</Line>
      {children}
    </box>
  );
}

/**
 * The selected row of a list and the window of rows shown around it: j/k, arrows, g/G.
 * `follow` keeps the selection on the newest row until the user moves it (live lists).
 */
export function useSelection<T>(
  items: readonly T[],
  height: number,
  options: { follow?: boolean; group?: string; disabled?: boolean } = {},
) {
  const [picked, setPicked] = useState<number | undefined>(undefined);
  const last = items.length - 1;
  const index = picked === undefined ? (options.follow ? last : 0) : Math.min(picked, last);
  const move = (delta: number) => setPicked(Math.max(0, Math.min(index + delta, last)));
  const group = options.group ?? "list";
  useBindings(
    () => ({
      bindings: options.disabled
        ? []
        : [
            { key: "j", cmd: () => move(1) },
            { key: "k", cmd: () => move(-1) },
            { key: "down", cmd: () => move(1) },
            { key: "up", cmd: () => move(-1) },
            { key: "pagedown", cmd: () => move(height) },
            { key: "pageup", cmd: () => move(-height) },
            { key: "g", cmd: () => setPicked(0) },
            { key: "shift+g", cmd: () => setPicked(undefined), desc: "follow", group },
          ],
    }),
    [index, last, height, options.disabled],
  );
  const rows = Math.max(1, height);
  const first = Math.max(0, Math.min(index - Math.floor(rows / 2), items.length - rows));
  return {
    index,
    selected: index >= 0 ? items[index] : undefined,
    first,
    visible: items.slice(first, first + rows),
    select: setPicked,
  };
}
