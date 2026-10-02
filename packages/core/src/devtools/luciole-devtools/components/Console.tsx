"use client";
import { useEffect, useState } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { useBindings, useNavigate } from "@luciole-sh/core/client";
import type { LogEntry } from "../../model/session";
import { useDevtools } from "./store";
import { clock, color, Line, shortId, useSelection } from "./ui";

/**
 * Both processes' console: the Client's (the TUI owns its stdout, this is the only place
 * to read them) and the Server's, each Server line tagged with the request it ran under.
 * `callId` comes from the URL (`/console?callId=…`, opened from the Network panel).
 */
const LEVELS = ["all", "warn", "error"] as const;
const ROLES = ["all", "client", "server"] as const;
const CHROME_LINES = 6,
  DETAIL_LINES = 8,
  LEVEL_WIDTH = 5;
const LEVEL_COLOR: Record<string, string> = {
  log: color.text,
  info: color.client,
  debug: color.muted,
  warn: color.warn,
  error: color.error,
};
const cycle = <T,>(values: readonly T[], value: T) =>
  values[(values.indexOf(value) + 1) % values.length] ?? value;
const shown = (
  entry: LogEntry,
  level: string,
  role: string,
  query: string,
  callId: string | undefined,
) =>
  (level === "all" ||
    (level === "warn"
      ? entry.level === "warn" || entry.level === "error"
      : entry.level === "error")) &&
  (role === "all" || entry.role === role) &&
  (!callId || entry.callId === callId) &&
  (!query || entry.text.toLowerCase().includes(query.toLowerCase()));

export function ConsolePanel({ callId }: { callId?: string }) {
  const store = useDevtools();
  const navigate = useNavigate();
  const { height } = useTerminalDimensions();
  const [level, setLevel] = useState<(typeof LEVELS)[number]>("all");
  const [role, setRole] = useState<(typeof ROLES)[number]>("all");
  const [query, setQuery] = useState("");
  const typing = store.typing;
  const setTyping = (next: boolean) => store.setTyping(next);
  const root = store.session.root();
  const entries = store.session.logs().filter((e) => shown(e, level, role, query, callId));
  const list = useSelection(entries, height - CHROME_LINES, { follow: true, disabled: typing });
  // Leaving the panel gives the keyboard back.
  useEffect(() => () => store.setTyping(false), [store]);
  useBindings(
    () => ({
      bindings: typing
        ? [
            { key: "return", cmd: () => setTyping(false), desc: "done", group: "panel" },
            { key: "escape", cmd: () => setTyping(false) },
          ]
        : [
            {
              key: "l",
              cmd: () => setLevel(cycle(LEVELS, level)),
              desc: `level ${level}`,
              group: "panel",
            },
            {
              key: "s",
              cmd: () => setRole(cycle(ROLES, role)),
              desc: `source ${role}`,
              group: "panel",
            },
            { key: "/", cmd: () => setTyping(true), desc: "search", group: "panel" },
            ...(callId
              ? [
                  {
                    key: "x",
                    cmd: () => void navigate({ to: "/console" }),
                    desc: "all requests",
                    group: "panel",
                  },
                ]
              : []),
          ],
    }),
    [typing, level, role, callId, navigate],
  );
  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" height={1} flexShrink={0} gap={1}>
        <Line fg={color.muted}>
          {`${entries.length} lines · level ${level} · source ${role}${callId ? ` · request ${shortId(callId)}` : ""} · /`}
        </Line>
        <input
          focused={typing}
          value={query}
          onInput={setQuery}
          placeholder="search"
          flexGrow={1}
        />
      </box>
      <box flexDirection="column" flexGrow={1} overflow="hidden">
        {entries.length === 0 ? <Line fg={color.faint}>No log line.</Line> : null}
        {list.visible.map((entry, i) => (
          <text
            key={entry.seq}
            height={1}
            flexShrink={0}
            wrapMode="none"
            truncate
            bg={list.first + i === list.index ? color.selected : undefined}
          >
            <span fg={color.faint}>{`${clock(entry.at)} `}</span>
            <span fg={entry.role === "server" ? color.server : color.client}>
              {entry.role === "server" ? "S " : "C "}
            </span>
            <span
              fg={LEVEL_COLOR[entry.level] ?? color.text}
            >{`${entry.level.padEnd(LEVEL_WIDTH)} `}</span>
            {entry.callId ? <span fg={color.faint}>{`${shortId(entry.callId)} `}</span> : null}
            <span fg={LEVEL_COLOR[entry.level] ?? color.text}>{entry.text.split("\n")[0]}</span>
          </text>
        ))}
      </box>
      {list.selected && (list.selected.stack || list.selected.text.includes("\n")) ? (
        <box flexDirection="column" flexShrink={0} border={["top"]} borderColor={color.faint}>
          {/* An error's stack, mapped to the original files by the bundle's source map. */}
          {(list.selected.stack ?? list.selected.text)
            .split("\n")
            .slice(0, DETAIL_LINES)
            .map((line, i) => (
              <Line key={i} fg={color.muted}>
                {root ? line.replaceAll(`${root}/`, "") : line}
              </Line>
            ))}
        </box>
      ) : null}
    </box>
  );
}
