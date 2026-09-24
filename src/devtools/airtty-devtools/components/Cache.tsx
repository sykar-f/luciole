"use client";
import { useState } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { useBindings } from "airtty/client";
import { useDevtools, useTicker } from "./store";
import { age, clock, color, fit, Line, ms, useSelection } from "./ui";

/**
 * The Server cache, as its events describe it (feat/use-cache's `cache` events): each
 * entry with its function, tags, age and hit rate, and tag invalidations. The Client
 * router's cache is in the Router panel. `x` invalidates a tag of the selected entry on the
 * Server, outside any request: the Server cache is purged, no Client is told.
 */
type Command = (role: string, suffix: string, payload: unknown) => Promise<{ sent: number }>;
const TICK_MS = 1000;
const RECENT_USES = 4,
  PERCENT = 100,
  COUNTS = 15;
const KEY = 28,
  FN = 24,
  OP = 10,
  AGE = 8,
  CHROME_LINES = 8,
  DETAIL_LINES = 7;
const OP_COLOR: Record<string, string> = {
  hit: color.ok,
  miss: color.cache,
  stale: color.warn,
  write: color.client,
  invalidate: color.error,
};

export function CachePanel({ command }: { command: Command }) {
  const store = useDevtools();
  const [tagIndex, setTagIndex] = useState(0);
  const [status, setStatus] = useState("");
  const { height } = useTerminalDimensions();
  const entries = store.session.cache();
  const now = useTicker(TICK_MS, entries.length > 0);
  const list = useSelection(entries, height - CHROME_LINES - DETAIL_LINES);
  const selected = list.selected;
  const tags = selected?.tags ?? [];
  const tag = tags.length ? tags[tagIndex % tags.length] : undefined;
  useBindings(
    () => ({
      bindings: [
        ...(tags.length > 1
          ? [{ key: "t", cmd: () => setTagIndex((i) => i + 1), desc: "next tag", group: "panel" }]
          : []),
        ...(tag
          ? [
              {
                key: "x",
                cmd: () =>
                  void command("server", "cache-invalidate", { tag }).then(
                    ({ sent }) =>
                      setStatus(
                        sent
                          ? `Asked the Server to purge tag "${tag}"; its invalidate events follow. No Client is told: each sees fresh data on its next render.`
                          : "No Server connected.",
                      ),
                    (e: unknown) => setStatus(`Failed: ${String(e)}`),
                  ),
                desc: `invalidate ${tag}`,
                group: "panel",
              },
            ]
          : []),
      ],
    }),
    [tags, tag, command],
  );
  if (!entries.length)
    return (
      <box flexDirection="column">
        <Line fg={color.faint}>No Server cache event yet.</Line>
        <Line fg={color.faint}>
          They come from the Server&apos;s cache (feat/use-cache); `airtty devtools --demo`
          simulates them.
        </Line>
      </box>
    );
  // The requests that read or wrote the selected entry, latest last.
  const uses = selected
    ? store.session.network
        .rows()
        .flatMap((row) =>
          row.cache
            .filter((c) => c.key === selected.key)
            .map(
              (c) =>
                `${row.target.split("#").at(-1)} ${c.op}${c.ms === undefined ? "" : ` ${ms(c.ms)}`}`,
            ),
        )
        .slice(-RECENT_USES)
        .join(" · ")
    : "";
  const reads = entries.reduce((n, e) => n + e.hits + e.misses + e.stale, 0);
  const hits = entries.reduce((n, e) => n + e.hits, 0);
  return (
    <box flexDirection="column" flexGrow={1}>
      <Line fg={color.muted}>
        {`${entries.length} entries · ${reads} reads · hit rate ${reads ? Math.round((hits / reads) * PERCENT) : 0}% · ${store.session.tagInvalidations().length} invalidations`}
      </Line>
      <Line
        fg={color.faint}
      >{`${fit("key", KEY)} ${fit("function", FN)} ${fit("last", OP)} ${fit("age", AGE)} hit/miss/stale  tags`}</Line>
      <box flexDirection="column" flexGrow={1} overflow="hidden">
        {list.visible.map((entry, i) => (
          <text
            key={entry.key}
            height={1}
            flexShrink={0}
            wrapMode="none"
            truncate
            bg={list.first + i === list.index ? color.selected : undefined}
          >
            <span fg={entry.invalidatedAt ? color.faint : color.text}>{fit(entry.key, KEY)} </span>
            <span fg={color.muted}>{fit(entry.fn.split("#").at(-1) ?? entry.fn, FN)} </span>
            <span fg={OP_COLOR[entry.lastOp] ?? color.muted}>{fit(entry.lastOp, OP)} </span>
            <span fg={color.muted}>
              {fit(entry.invalidatedAt ? "invalid" : age(entry.writtenAt, now), AGE)}{" "}
            </span>
            <span fg={color.muted}>
              {`${entry.hits}/${entry.misses}/${entry.stale}`.padEnd(COUNTS)}
            </span>
            <span fg={color.faint}>{entry.tags.join(" ")}</span>
          </text>
        ))}
      </box>
      <box
        flexDirection="column"
        height={DETAIL_LINES}
        flexShrink={0}
        border={["top"]}
        borderColor={color.faint}
      >
        {selected ? (
          <>
            <Line>{`${selected.key} · ${selected.fn}`}</Line>
            <Line fg={color.muted}>
              {`written ${selected.writtenAt ? clock(selected.writtenAt) : "–"} · last ${selected.lastOp} ${clock(selected.lastAt)}${selected.invalidatedAt ? ` · invalidated ${clock(selected.invalidatedAt)}` : ""}`}
            </Line>
            <Line fg={color.muted}>
              {`tags ${selected.tags.map((t) => (t === tag ? `[${t}]` : t)).join(", ") || "–"}${tag ? " · x invalidates the [tag] on the Server only (no Client told)" : ""}`}
            </Line>
            <Line fg={color.faint}>{uses ? `requests: ${uses}` : ""}</Line>
            <Line fg={color.warn}>{status}</Line>
          </>
        ) : null}
      </box>
    </box>
  );
}
