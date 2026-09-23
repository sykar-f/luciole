"use client";
import { useEffect, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { useApplication, useLive } from "airtty/client";
import { checkLog, rerunChecks, resolveOperation } from "../actions/pulls";
import { useEditing } from "./editing";
import { Line } from "./frames";
import type { Check, PullDetail } from "./model";
import { describe, useOperation } from "./operations";
import { checkColor, checkGlyph, color } from "./theme";

const SECOND_MS = 1000;
/**
 * Logs stream line by line from a Server generator (`useLive`) while the tab is open, with
 * no polling; leaving the tab closes them. When a check that was running finishes, this
 * component invalidates the route once to refresh statuses and merge readiness.
 */
export function ChecksPanel({
  pull,
  checks,
  canRun,
}: {
  pull: PullDetail;
  checks: Check[];
  canRun: boolean;
}) {
  const [selected, setSelected] = useState(0);
  const { editing } = useEditing();
  const rerun = useOperation(`rerun:${pull.repo}#${pull.number}`);
  const check = checks[Math.min(selected, checks.length - 1)];
  useKeyboard((key) => {
    if (key.ctrl && key.name === "o") void rerun.resolve(resolveOperation);
    if (editing || key.ctrl) return;
    if (key.name === "j" || key.name === "down")
      setSelected((s) => Math.min(s + 1, checks.length - 1));
    if (key.name === "k" || key.name === "up") setSelected((s) => Math.max(s - 1, 0));
    if (key.name === "r" && canRun) {
      rerun.forget();
      void rerun.run("Rerun checks", (operationId) =>
        rerunChecks({ repo: pull.repo, number: pull.number, operationId }),
      );
    }
  });
  return (
    <box flexDirection="column" flexGrow={1} gap={1}>
      <box flexDirection="row" flexGrow={1} gap={2}>
        <box
          id="check-list"
          width={30}
          flexShrink={0}
          flexDirection="column"
          border
          borderColor={color.border}
          paddingX={1}
          title={` revision ${pull.revision} `}
        >
          {checks.map((c, i) => (
            <CheckRow
              key={`${c.id}:${c.attempt}`}
              check={c}
              active={i === selected}
              onSelect={() => setSelected(i)}
            />
          ))}
        </box>
        {check ? (
          <CheckLog key={check.id} check={check} />
        ) : (
          <Line fg={color.muted}>No checks</Line>
        )}
      </box>
      <Line id="checks-status" fg={color.warn}>
        {describe(rerun.state)}
      </Line>
    </box>
  );
}

function CheckRow({
  check,
  active,
  onSelect,
}: {
  check: Check;
  active: boolean;
  onSelect: () => void;
}) {
  const app = useApplication();
  const { done, items: lines } = useLive(checkLog, [check.id]);
  // Remounted for each attempt: was this attempt still running when it was rendered?
  const [live] = useState(() => check.status === "running" || check.status === "queued");
  const invalidated = useRef(false);
  // Explicit invalidation when a live check ends: statuses are Server data.
  useEffect(() => {
    if (!done || !live || invalidated.current) return;
    invalidated.current = true;
    void app.invalidate().catch(() => {});
  }, [done, live, app]);
  // The stream is fresher than the rendered snapshot until the route is invalidated.
  const last = lines.at(-1) ?? "";
  const status = !live
    ? check.status
    : last.includes("✓ passed")
      ? "success"
      : last.includes("✗ failed")
        ? "failure"
        : lines.length
          ? "running"
          : check.status;
  return (
    <box
      flexDirection="row"
      height={1}
      backgroundColor={active ? color.selected : undefined}
      onMouseDown={onSelect}
    >
      <text width={2} fg={checkColor[status]}>
        {checkGlyph[status]}
      </text>
      <text flexGrow={1} fg={color.text}>
        {check.name}
      </text>
      <text fg={color.muted}>
        #{check.attempt} {(check.durationMs / SECOND_MS).toFixed(1)}s
      </text>
    </box>
  );
}

function CheckLog({ check }: { check: Check }) {
  const { items: lines, done, error } = useLive(checkLog, [check.id]);
  return (
    <box flexDirection="column" flexGrow={1}>
      <Line id="log-heading" fg={color.text}>
        {check.name} · attempt {check.attempt} ·{" "}
        <span fg={done ? color.muted : color.warn}>{done ? "log complete" : "streaming…"}</span>
      </Line>
      <scrollbox
        id="check-log"
        flexGrow={1}
        scrollY
        stickyScroll
        stickyStart="bottom"
        border
        borderColor={color.border}
      >
        {lines.map((line, i) => (
          <text
            key={i}
            wrapMode="none"
            fg={line.includes("✗") ? color.danger : line.includes("✓") ? color.ok : color.text}
          >
            {line}
          </text>
        ))}
        {error ? (
          <text fg={color.danger}>
            {error instanceof Error ? error.message : "Stream interrupted"} · Ctrl+R to reload
          </text>
        ) : null}
      </scrollbox>
    </box>
  );
}
