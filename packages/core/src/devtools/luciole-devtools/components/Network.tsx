"use client";
import { useState } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { useBindings, useNavigate } from "@luciole-sh/core/client";
import {
  cacheBadge,
  phases,
  rowEnd,
  rowStart,
  rowStatus,
  type Flags,
  type Row,
} from "../../model/network";
import { useDevtools, useTicker } from "./store";
import { bytes, color, fit, Line, ms, shortId, useSelection } from "./ui";

/**
 * Chrome's Network panel for one application: a waterfall of every request, Client and
 * Server sides together, with the cache that answered it and the two diagnostics that
 * cost round trips (sequential requests, double invalidations).
 */
const FILTERS = ["all", "flagged", "render", "action", "cache"] as const;
const MINUTE = 60_000,
  TEN_SECONDS = 10_000,
  TWO_SECONDS = 2000;
const WINDOWS = [undefined, MINUTE, TEN_SECONDS, TWO_SECONDS] as const;
const TICK_MS = 250;
// Columns before the bar: flag, status, name, cause, cache, duration, spaces.
const NAME = 26,
  CAUSE = 5,
  BADGE = 5,
  TIME = 6,
  LEFT = 2 + NAME + 1 + CAUSE + 1 + BADGE + 1 + TIME + 1;
const DETAIL_LINES = 10,
  CHROME_LINES = 7;
const MIN_BAR = 10,
  PADDING = 3;

const CAUSE_LABEL: Record<string, string> = {
  navigation: "nav",
  preload: "pre",
  refresh: "ref",
  invalidation: "inv",
  action: "act",
  live: "live",
  unknown: "?",
};
const STATUS_GLYPH: Record<string, [string, string]> = {
  pending: ["…", color.muted],
  streaming: ["~", color.stream],
  done: ["✓", color.ok],
  error: ["✕", color.error],
  cancelled: ["⊘", color.muted],
  aborted: ["⊘", color.muted],
  cached: ["◆", color.router],
};
const BADGE_LABEL: Record<string, [string, string]> = {
  router: ["mem", color.router],
  hit: ["hit", color.ok],
  miss: ["miss", color.cache],
  stale: ["stale", color.warn],
  partial: ["part", color.warn],
};
const name = (row: Row) =>
  row.kind === "render"
    ? `▣ ${row.href ?? row.target}`
    : `ƒ ${row.target.split("#").at(-1) ?? row.target}`;

type Cell = { ch: string; fg: string };
/** The row's bar over [t0, t0 + span]: queued ░, waiting ▒, Server work █, stream ━ with chunks ╋. */
function bar(row: Row, t0: number, span: number, width: number, horizon: number): Cell[] {
  const cells: Cell[] = Array.from({ length: width }, () => ({ ch: " ", fg: color.faint }));
  const x = (at: number) =>
    Math.max(0, Math.min(width - 1, Math.floor(((at - t0) / span) * width)));
  const fill = (from: number | undefined, to: number | undefined, ch: string, fg: string) => {
    if (from === undefined || to === undefined) return;
    for (let i = x(from); i <= x(Math.max(from, to)); i++) cells[i] = { ch, fg };
  };
  const start = rowStart(row);
  if (row.source !== "network" && row.client.request === undefined) {
    cells[x(start)] = { ch: "◆", fg: row.source === "router-cache" ? color.router : color.muted };
    return cells;
  }
  const end = rowEnd(row) ?? horizon;
  fill(start, row.client.request, "░", color.faint);
  fill(row.client.request, row.client.response ?? end, "▒", color.warn);
  fill(row.server.request, row.server.response ?? row.server.end ?? end, "█", color.ok);
  if (row.client.response !== undefined) fill(row.client.response, end, "━", color.stream);
  for (const chunk of row.client.chunks) cells[x(chunk.at)] = { ch: "╋", fg: color.stream };
  const failed = row.client.error ?? row.server.error;
  if (failed) cells[x(failed.at)] = { ch: "✕", fg: color.error };
  if (row.client.cancelled && row.client.end !== undefined)
    cells[x(row.client.end)] = { ch: "⊘", fg: color.muted };
  return cells;
}
/** Consecutive cells of one color as one span. */
function spans(cells: readonly Cell[]) {
  const out: Cell[] = [];
  for (const cell of cells) {
    const last = out.at(-1);
    if (last && last.fg === cell.fg) last.ch += cell.ch;
    else out.push({ ...cell });
  }
  return out;
}
const matches = (filter: (typeof FILTERS)[number], row: Row, flags: Flags | undefined) =>
  filter === "all" ||
  (filter === "flagged" && !!(flags?.waterfallAfter || flags?.doubleInvalidation)) ||
  (filter === "render" && row.kind === "render") ||
  (filter === "action" && row.kind === "action") ||
  (filter === "cache" && cacheBadge(row) !== undefined);

export function NetworkPanel() {
  const store = useDevtools();
  const navigate = useNavigate();
  const { width, height } = useTerminalDimensions();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [zoom, setZoom] = useState(0);
  const network = store.session.network;
  const flags = network.derive();
  const all = network.rows();
  const rows = all.filter((row) => matches(filter, row, flags.get(row.key)));
  const live = store.session.sources().some((s) => s.connected) && !store.paused;
  const open = rows.some((row) => rowEnd(row) === undefined && row.source === "network");
  const now = useTicker(TICK_MS, live && open);
  const list = useSelection(rows, height - CHROME_LINES - DETAIL_LINES, { follow: true });
  const selected = list.selected;
  useBindings(
    () => ({
      bindings: [
        {
          key: "f",
          cmd: () => setFilter((f) => FILTERS[(FILTERS.indexOf(f) + 1) % FILTERS.length] ?? "all"),
          desc: `filter ${filter}`,
          group: "panel",
        },
        {
          key: "z",
          cmd: () => setZoom((z) => (z + 1) % WINDOWS.length),
          desc: "zoom",
          group: "panel",
        },
        ...(selected?.callId
          ? [
              {
                key: "o",
                cmd: () => void navigate({ to: "/console", search: { callId: selected.callId } }),
                desc: "logs",
                group: "panel",
              },
            ]
          : []),
      ],
    }),
    [filter, selected, navigate],
  );

  // Time axis: every row shown, up to now while the application streams.
  const ends = all.map((row) => rowEnd(row) ?? row.client.chunks.at(-1)?.at ?? rowStart(row));
  const horizon = Math.max(...ends, live ? now : 0);
  const windowMs = WINDOWS[zoom];
  const t0 = windowMs ? horizon - windowMs : Math.min(...all.map(rowStart));
  const span = Math.max(1, horizon - t0);
  // The layout's side padding, and a cell of slack: a line one cell too long is cut
  // in its middle.
  const barWidth = Math.max(MIN_BAR, width - LEFT - PADDING);
  const flaggedCount = all.filter((row) => {
    const f = flags.get(row.key);
    return f?.waterfallAfter || f?.doubleInvalidation;
  }).length;

  return (
    <box flexDirection="column" flexGrow={1}>
      <Line fg={color.muted}>
        {`${all.length} requests · ${flaggedCount} flagged · filter ${filter} · window ${windowMs ? ms(windowMs) : "all"} (${ms(span)})`}
      </Line>
      <Line fg={color.faint}>
        {`  ${fit("name", NAME)} ${fit("cause", CAUSE)} ${fit("cache", BADGE)} ${fit("time", TIME)} ░ queued ▒ waiting █ server ━ stream ╋ chunk ◆ cache`}
      </Line>
      <box flexDirection="column" flexGrow={1} overflow="hidden">
        {rows.length === 0 ? <Line fg={color.faint}>No request yet.</Line> : null}
        {list.visible.map((row, i) => {
          const f = flags.get(row.key);
          const status = rowStatus(row);
          const [glyph, glyphColor] = STATUS_GLYPH[status] ?? ["?", color.muted];
          const badge = cacheBadge(row);
          const [label, labelColor] = badge
            ? (BADGE_LABEL[badge] ?? ["", color.muted])
            : ["", color.muted];
          const end = rowEnd(row);
          const isSelected = list.first + i === list.index;
          return (
            <text
              key={row.key}
              height={1}
              flexShrink={0}
              wrapMode="none"
              truncate
              bg={isSelected ? color.selected : undefined}
            >
              <span fg={f?.doubleInvalidation ? color.error : color.warn}>
                {f?.doubleInvalidation ? "⟳" : f?.waterfallAfter ? "↳" : " "}
              </span>
              <span fg={glyphColor}>{glyph} </span>
              <span fg={row.kind === "render" ? color.text : color.client}>
                {fit(name(row), NAME)}{" "}
              </span>
              <span fg={color.muted}>{fit(CAUSE_LABEL[row.cause] ?? row.cause, CAUSE)} </span>
              <span fg={labelColor}>{fit(label, BADGE)} </span>
              <span fg={color.muted}>
                {fit(
                  end === undefined
                    ? status === "streaming"
                      ? "live"
                      : "…"
                    : ms(end - rowStart(row)),
                  TIME,
                )}{" "}
              </span>
              {spans(bar(row, t0, span, barWidth, horizon)).map((cell, j) => (
                <span key={j} fg={cell.fg}>
                  {cell.ch}
                </span>
              ))}
            </text>
          );
        })}
      </box>
      <Detail
        width={barWidth + LEFT - 1}
        horizon={horizon}
        row={selected}
        flags={selected ? flags.get(selected.key) : undefined}
        rows={all}
        logs={
          store.session.logs().filter((l) => selected?.callId && l.callId === selected.callId)
            .length
        }
      />
    </box>
  );
}

function Detail({
  width,
  horizon,
  row,
  flags,
  rows,
  logs,
}: {
  width: number;
  horizon: number;
  row: Row | undefined;
  flags: Flags | undefined;
  rows: readonly Row[];
  logs: number;
}) {
  if (!row) return <box height={DETAIL_LINES} flexShrink={0} />;
  const p = phases(row);
  const start = rowStart(row);
  const end = rowEnd(row);
  const serverWork =
    row.server.request !== undefined && row.server.response !== undefined
      ? row.server.response - row.server.request
      : undefined;
  const stream =
    end !== undefined && row.client.response !== undefined ? end - row.client.response : undefined;
  const before = flags?.waterfallAfter
    ? rows.find((r) => r.key === flags.waterfallAfter)
    : undefined;
  const beforeDone = before ? (before.client.end ?? before.client.response) : undefined;
  const twins = flags?.doubleInvalidation
    ? rows.filter((r) => r.invalidatedBy === flags.doubleInvalidation && r.target === row.target)
    : [];
  const rel = (at: number | undefined) => (at === undefined ? "–" : `+${ms(at - start)}`);
  return (
    <box
      flexDirection="column"
      height={DETAIL_LINES}
      flexShrink={0}
      border={["top"]}
      borderColor={color.faint}
    >
      <Line>
        {`${row.kind} ${row.target}${row.href ? ` · ${row.href}` : ""} · cause ${row.cause} · ${rowStatus(row)}${row.client.status ? ` ${row.client.status}` : ""}${row.callId ? ` · call ${shortId(row.callId)}` : ""}${row.source !== "network" ? ` · ${row.source}` : ""}`}
      </Line>
      <Line fg={color.muted}>
        {`queued ${ms(p.queued)} · TTFB ${ms(p.ttfb)} · server ${ms(serverWork)} · stream ${ms(stream)} · total ${ms(end === undefined ? undefined : end - start)} · ${bytes(row.client.bytes)} in ${row.client.chunks.length} chunks`}
      </Line>
      <text height={1} flexShrink={0} wrapMode="none" truncate>
        {/* The request alone, at its own scale: phases a long session's axis squeezes. */}
        {spans(bar(row, start, Math.max(1, (end ?? horizon) - start), width, horizon)).map(
          (cell, j) => (
            <span key={j} fg={cell.fg}>
              {cell.ch}
            </span>
          ),
        )}
      </text>
      <Line fg={color.server}>
        {row.server.request === undefined
          ? "Server: no event (not instrumented, or never reached)"
          : `Server: request ${rel(row.server.request)} · headers ${rel(row.server.response)} · end ${rel(row.server.end)}${row.server.bytes === undefined ? "" : ` · ${bytes(row.server.bytes)}`}${row.server.error ? ` · error ${row.server.error.message}` : ""}`}
      </Line>
      <Line fg={color.cache}>
        {row.cache.length
          ? `Cache: ${row.cache.map((c) => `${c.op} ${c.key}${c.ms === undefined ? "" : ` ${ms(c.ms)}`}`).join(" · ")}`
          : row.source === "router-cache"
            ? "Cache: answered by the Client router's cache, no request"
            : "Cache: –"}
      </Line>
      <Line fg={color.warn}>
        {before
          ? `↳ Sequential: started ${ms((row.client.request ?? 0) - (beforeDone ?? 0))} after ${name(before)} answered; could they run together?`
          : ""}
      </Line>
      <Line fg={color.error}>
        {twins.length > 1
          ? `⟳ Double invalidation: ${twins.length} renders of ${row.target} for one cause (${flags?.doubleInvalidation})`
          : ""}
      </Line>
      <Line fg={color.error}>
        {row.client.error ? `✕ ${row.client.error.outcome}: ${row.client.error.message}` : ""}
      </Line>
      <Line fg={color.faint}>
        {logs ? `${logs} log line(s) for this request · o opens them` : ""}
      </Line>
    </box>
  );
}
