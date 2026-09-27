"use client";
import { MODE_LABELS, type Mode, type PlanStep, type Snapshot } from "./model";
import { color } from "./theme";

const PERCENT = 100;
const METER = 6;
const THOUSAND = 1000;
const CENTS = 2;
// Past this share of the context window, the meter warns.
const CONTEXT_WARNING = 0.8;

/** Shown instead of « powered by … » with the fake harness (the website reads it too). */
export const SCRIPTED = "Scripted demo · no model calls";

const MODE_GLYPH: Record<Mode, string> = { read: "◎", ask: "✋", edits: "✎", full: "⚡" };
const MODE_COLOR: Record<Mode, string> = {
  read: color.info,
  ask: color.ok,
  edits: color.warn,
  full: color.danger,
};

const tokens = (n: number) => (n >= THOUSAND ? `${Math.round(n / THOUSAND)}k` : String(n));
function meter(fraction: number) {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * METER);
  return "▓".repeat(filled) + "░".repeat(METER - filled);
}

/** Model · effort · mode │ context │ limits │ cost │ tasks, and who powers it. */
export function StatusLine({
  snap,
  message,
}: {
  snap: Snapshot;
  message?: { text: string; fg: string };
}) {
  const { info, usage } = snap;
  const running = snap.items.filter((i) => i.kind === "subagent" && i.status === "running").length;
  const context = usage.context;
  const limits = [
    usage.limits?.fiveHour !== undefined ? `5h ${Math.round(usage.limits.fiveHour)} %` : undefined,
    usage.limits?.weekly !== undefined ? `7d ${Math.round(usage.limits.weekly)} %` : undefined,
  ].filter((l) => l !== undefined);
  return (
    <>
      <text flexShrink={0} fg={color.text}>
        {info.model ?? "default model"}
        {info.effort ? <span fg={color.muted}> · {info.effort}</span> : null}
        <span fg={color.muted}> · </span>
        <span fg={MODE_COLOR[info.mode]}>
          {MODE_GLYPH[info.mode]} {MODE_LABELS[info.mode]}
        </span>
      </text>
      {context && context.window ? (
        <text flexShrink={0} fg={color.muted}>
          {" │ ctx "}
          <span fg={context.used / context.window > CONTEXT_WARNING ? color.warn : color.accent}>
            {meter(context.used / context.window)}
          </span>{" "}
          {Math.round((context.used / context.window) * PERCENT)} %
        </text>
      ) : null}
      {limits.length ? (
        <text flexShrink={0} fg={color.muted}>
          {" │ "}
          {limits.join(" · ")}
        </text>
      ) : null}
      {usage.costUsd !== undefined ? (
        <text flexShrink={0} fg={color.muted}>
          {" │ $"}
          {usage.costUsd.toFixed(CENTS)}
        </text>
      ) : usage.tokens ? (
        <text flexShrink={0} fg={color.muted}>
          {" │ ↑"}
          {tokens(usage.tokens.input)} ↓{tokens(usage.tokens.output)}
        </text>
      ) : null}
      {running ? (
        <text flexShrink={0} fg={color.thinking}>
          {" │ "}
          {running} task{running === 1 ? "" : "s"}
        </text>
      ) : null}
      <text flexGrow={1} flexShrink={1} wrapMode="none" truncate fg={message?.fg ?? color.faint}>
        {message ? ` │ ${message.text}` : ""}
      </text>
      {/* The scripted harness says what it is: a demo, which no model answers. */}
      <text flexShrink={0} fg={info.harness === "fake" ? color.warn : color.faint}>
        {" "}
        {info.harness === "fake" ? SCRIPTED : `powered by ${info.poweredBy}`}
      </text>
    </>
  );
}

const STEP_GLYPH: Record<PlanStep["status"], { glyph: string; fg: string }> = {
  completed: { glyph: "✓", fg: color.ok },
  in_progress: { glyph: "●", fg: color.warn },
  pending: { glyph: "○", fg: color.muted },
};

/** The agent's plan, one line above the composer. */
export function PlanBar({ steps }: { steps: readonly PlanStep[] }) {
  const done = steps.filter((s) => s.status === "completed").length;
  return (
    <text flexGrow={1} wrapMode="none" truncate fg={color.muted}>
      <span fg={color.accent}>
        ☐ Plan {done}/{steps.length}
      </span>
      {steps.map((step, i) => (
        <span key={i} fg={STEP_GLYPH[step.status].fg}>
          {"  "}
          {STEP_GLYPH[step.status].glyph} {step.text}
        </span>
      ))}
    </text>
  );
}
