"use client";
import { useTerminalDimensions } from "@opentui/react";
import { useBindings } from "airtty/client";
import type { RouterMatch } from "../../schema";
import { useDevtools, useTicker } from "./store";
import { age, color, fit, Line, useSelection } from "./ui";

/**
 * TanStack Router's devtools panel, in the terminal: the location, the matches rendered
 * now and those kept in the router's cache, with their status and age, and a way to
 * invalidate one (the application reloads it as after `invalidate()`).
 */
type Command = (role: string, suffix: string, payload: unknown) => Promise<unknown>;
const TICK_MS = 1000;
const ROUTE = 22,
  PATH = 22,
  STATUS = 9,
  AGE = 8,
  CHROME_LINES = 8,
  DETAIL_LINES = 4;
const STATUS_COLOR: Record<string, string> = {
  success: color.ok,
  pending: color.warn,
  error: color.error,
  notFound: color.warn,
};
type Item = { match: RouterMatch; cached: boolean };

export function RouterPanel({ command }: { command: Command }) {
  const store = useDevtools();
  const { height } = useTerminalDimensions();
  const state = store.session.router();
  const now = useTicker(TICK_MS, state !== undefined);
  const items: Item[] = state
    ? [
        ...state.matches.map((match) => ({ match, cached: false })),
        ...state.cached.map((match) => ({ match, cached: true })),
      ]
    : [];
  const list = useSelection(items, height - CHROME_LINES - DETAIL_LINES);
  const selected = list.selected?.match;
  const send = (suffix: string, payload: unknown) =>
    void command("client", suffix, payload).catch(() => {});
  useBindings(
    () => ({
      bindings: [
        ...(selected
          ? [
              {
                key: "i",
                cmd: () => send("invalidate", { paths: [selected.pathname] }),
                desc: "invalidate",
                group: "panel",
              },
            ]
          : []),
        {
          key: "shift+i",
          cmd: () => send("invalidate", {}),
          desc: "invalidate all",
          group: "panel",
        },
        { key: "r", cmd: () => send("refresh", {}), desc: "refresh", group: "panel" },
      ],
    }),
    [selected],
  );
  if (!state) return <Line fg={color.faint}>No router state yet.</Line>;
  const pending = state.resolvedHref !== state.href;
  return (
    <box flexDirection="column" flexGrow={1}>
      <Line>
        <span fg={state.status === "pending" ? color.warn : color.ok}>{`● ${state.status} `}</span>
        <span fg={color.text}>{state.href}</span>
        {pending ? <span fg={color.warn}>{` (resolved ${state.resolvedHref ?? "–"})`}</span> : null}
      </Line>
      <Line fg={color.faint}>
        {`  ${fit("route", ROUTE)} ${fit("pathname", PATH)} ${fit("status", STATUS)} ${fit("age", AGE)} data`}
      </Line>
      <box flexDirection="column" flexGrow={1} overflow="hidden">
        {list.visible.map(({ match, cached }, i) => {
          const isSelected = list.first + i === list.index;
          const first = i === 0 || list.visible[i - 1]?.cached !== cached;
          return (
            <box key={`${cached}:${match.id}`} flexDirection="column" flexShrink={0}>
              {first ? (
                <Line fg={color.accent}>{cached ? "cached (not rendered)" : "matches"}</Line>
              ) : null}
              <text
                height={1}
                wrapMode="none"
                truncate
                bg={isSelected ? color.selected : undefined}
              >
                <span fg={match.isFetching ? color.warn : color.faint}>
                  {match.isFetching ? "↻ " : "  "}
                </span>
                <span fg={color.text}>{fit(match.routeId, ROUTE)} </span>
                <span fg={color.muted}>{fit(match.pathname, PATH)} </span>
                <span fg={STATUS_COLOR[match.status] ?? color.muted}>
                  {fit(match.invalid ? `${match.status}*` : match.status, STATUS)}{" "}
                </span>
                <span fg={color.muted}>{fit(age(match.updatedAt, now), AGE)} </span>
                <span fg={color.faint}>{match.loaderData ?? ""}</span>
                {match.preload ? <span fg={color.router}> preload</span> : null}
              </text>
            </box>
          );
        })}
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
            <Line>{`${selected.id}${selected.invalid ? " · invalid (stale, reloads on next visit)" : ""}${selected.error ? ` · error ${selected.error}` : ""}`}</Line>
            <Line
              fg={color.muted}
            >{`params ${JSON.stringify(selected.params ?? {})} · search ${JSON.stringify(selected.search ?? {})}`}</Line>
            <Line fg={color.faint}>
              * invalid · ↻ loading · i invalidates this match in the application
            </Line>
          </>
        ) : null}
      </box>
    </box>
  );
}
