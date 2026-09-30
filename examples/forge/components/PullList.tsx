"use client";
import { useEffect, useMemo, useState } from "react";
import { useBindings, useNavigate, useRouter } from "luciole/client";
import { useEditing, useEditingWhile } from "./editing";
import { Line } from "./frames";
import type { PullSummary } from "./model";
import { color, stateColor } from "./theme";

export type Section = { title: string; pulls: PullSummary[] };
const PRELOAD_DELAY_MS = 150;

const matches = (pull: PullSummary, query: string) => {
  const q = query.trim().toLowerCase();
  return (
    !q ||
    pull.title.toLowerCase().includes(q) ||
    pull.author.includes(q) ||
    `#${pull.number}` === q ||
    pull.repo.includes(q)
  );
};

/**
 * Filtering, selection, hover and scrolling are local: they never reach the Server.
 * Selecting a row preloads its pull request so Enter shows it without waiting.
 */
export function PullList({
  sections,
  emptyText,
  onCreate,
}: {
  sections: Section[];
  emptyText: string;
  onCreate?: () => void;
}) {
  const navigate = useNavigate();
  const router = useRouter();
  const { editing } = useEditing();
  const [filtering, setFiltering] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [hovered, setHovered] = useState<string | null>(null);
  useEditingWhile(filtering);

  const rows = useMemo(
    () =>
      sections.flatMap((section) =>
        section.pulls.filter((p) => matches(p, query)).map((pull) => ({ section, pull })),
      ),
    [sections, query],
  );
  const current = rows[Math.min(selected, rows.length - 1)]?.pull;
  const params = (p: PullSummary) => ({ repo: p.repo, number: String(p.number) });
  const open = (p: PullSummary) =>
    void navigate({ to: "/repos/$repo/pulls/$number", params: params(p) });

  // Prefetch the selected pull request after a short pause (TanStack preload cache).
  useEffect(() => {
    if (!current || filtering) return;
    const timer = setTimeout(() => {
      void router
        .preloadRoute({ to: "/repos/$repo/pulls/$number", params: params(current) })
        .catch(() => {});
    }, PRELOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [current, filtering, router]);

  const move = (delta: number) =>
    setSelected((s) => Math.max(0, Math.min(s + delta, rows.length - 1)));
  // While filtering, the field owns every key but the two that close it.
  useBindings(
    () => ({
      bindings: filtering
        ? [
            { key: "return", cmd: () => setFiltering(false), desc: "done", group: "list" },
            { key: "escape", cmd: () => setFiltering(false) },
          ]
        : editing
          ? []
          : [
              { key: "j", cmd: () => move(1), desc: "down", group: "list" },
              { key: "k", cmd: () => move(-1), desc: "up", group: "list" },
              { key: "down", cmd: () => move(1) },
              { key: "up", cmd: () => move(-1) },
              ...(current
                ? [{ key: "return", cmd: () => open(current), desc: "open", group: "list" }]
                : []),
              {
                key: "/",
                cmd: () => {
                  setFiltering(true);
                  setSelected(0);
                },
                desc: "filter",
                group: "list",
              },
              ...(onCreate
                ? [{ key: "n", cmd: onCreate, desc: "new pull request", group: "list" }]
                : []),
            ],
    }),
    [filtering, editing, rows.length, current, onCreate, navigate],
  );

  return (
    <box flexDirection="column" flexGrow={1} gap={1}>
      <box flexDirection="row" gap={1} height={1} flexShrink={0}>
        <Line fg={filtering ? color.accent : color.muted}>/ filter</Line>
        <input
          id="pull-filter"
          focused={filtering}
          value={query}
          onInput={(value) => {
            setQuery(value);
            setSelected(0);
          }}
          placeholder="title, author, #number"
          flexGrow={1}
        />
      </box>
      <scrollbox id="pull-list" flexGrow={1} scrollY>
        {rows.length === 0 ? <Line fg={color.muted}>{query ? "No match" : emptyText}</Line> : null}
        {rows.map(({ section, pull }, index) => {
          const heading = index === 0 || rows[index - 1].section !== section ? section.title : null;
          const key = `${pull.repo}#${pull.number}`;
          const active = index === Math.min(selected, rows.length - 1);
          return (
            <box key={key} flexDirection="column" flexShrink={0}>
              {heading ? <Line fg={color.muted}>{heading.toUpperCase()}</Line> : null}
              <box
                id={`pull-row-${pull.repo}-${pull.number}`}
                flexDirection="row"
                height={1}
                gap={1}
                backgroundColor={
                  active ? color.selected : hovered === key ? color.panel : undefined
                }
                onMouseOver={() => setHovered(key)}
                onMouseOut={() => setHovered((h) => (h === key ? null : h))}
                onMouseDown={() => {
                  setSelected(index);
                  open(pull);
                }}
              >
                <text width={2} fg={stateColor[pull.state]}>
                  {pull.state === "merged" ? "⇄" : pull.state === "open" ? "●" : "○"}
                </text>
                <text width={16} wrapMode="none" truncate fg={color.muted}>
                  {pull.repo}#{pull.number}
                </text>
                <text flexGrow={1} wrapMode="none" truncate fg={color.text}>
                  {pull.title}
                </text>
                <text width={8} wrapMode="none" fg={color.muted}>
                  @{pull.author}
                </text>
                <text width={12} wrapMode="none" fg={color.muted}>
                  <span fg={color.ok}>+{pull.additions}</span>{" "}
                  <span fg={color.danger}>-{pull.deletions}</span>
                </text>
                <text width={6} wrapMode="none" fg={color.muted}>
                  {pull.comments} ✎
                </text>
              </box>
            </box>
          );
        })}
      </scrollbox>
    </box>
  );
}
