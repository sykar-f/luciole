"use client";
import { useState } from "react";
import { useBindings } from "@luciole-sh/core/client";
import { color, fit, Line, useSelection } from "./ui";

/**
 * Chrome's network throttling, live: added latency, jitter, slow chunks and faults change
 * the next requests of the running Client, where `LUCIOLE_JITTER_MS`, `LUCIOLE_CHUNK_DELAY_MS`
 * and `LUCIOLE_FAULT` only set them at startup.
 */
type Command = (role: string, suffix: string, payload: unknown) => Promise<{ sent: number }>;
type Conditions = {
  latencyMs: number;
  jitterMs: number;
  chunkDelayMs: number;
  refuse: number;
  drop: number;
  cut: number;
};
const NONE: Conditions = { latencyMs: 0, jitterMs: 0, chunkDelayMs: 0, refuse: 0, drop: 0, cut: 0 };
const PRESETS: Record<string, { label: string; conditions: Conditions }> = {
  n: { label: "none", conditions: NONE },
  m: { label: "mobile", conditions: { ...NONE, latencyMs: 300, jitterMs: 150 } },
  s: { label: "slow stream", conditions: { ...NONE, chunkDelayMs: 250 } },
  f: {
    label: "flaky",
    conditions: { ...NONE, latencyMs: 100, refuse: 0.1, drop: 0.05, cut: 0.05 },
  },
};
const FIELDS = [
  { key: "latencyMs", label: "added latency", step: 50, max: 10_000, unit: "ms" },
  { key: "jitterMs", label: "jitter (each way)", step: 25, max: 5000, unit: "ms" },
  { key: "chunkDelayMs", label: "delay per chunk", step: 50, max: 5000, unit: "ms" },
  { key: "refuse", label: "refuse (not sent)", step: 0.05, max: 1, unit: "p" },
  { key: "drop", label: "drop response", step: 0.05, max: 1, unit: "p" },
  { key: "cut", label: "cut stream", step: 0.05, max: 1, unit: "p" },
] as const;
const PERCENT = 100,
  LABEL = 22;
const toCommand = (c: Conditions) => ({
  latencyMs: c.latencyMs,
  jitterMs: c.jitterMs,
  chunkDelayMs: c.chunkDelayMs,
  faults: (["refuse", "drop", "cut"] as const)
    .filter((t) => c[t] > 0)
    .map((type) => ({ type, p: c[type] })),
});

export function ConditionsPanel({ command }: { command: Command }) {
  const [conditions, setConditions] = useState<Conditions>(NONE);
  const [status, setStatus] = useState(
    "Not applied yet: the Client runs with its startup conditions.",
  );
  const list = useSelection(FIELDS, FIELDS.length);
  const apply = (next: Conditions) => {
    setConditions(next);
    void command("client", "network", toCommand(next)).then(
      ({ sent }) => setStatus(sent ? `Applied to ${sent} Client(s).` : "No Client connected."),
      (e: unknown) => setStatus(`Failed: ${String(e)}`),
    );
  };
  const field = list.selected;
  const adjust = (direction: number) => {
    if (!field) return;
    const value = Math.min(field.max, Math.max(0, conditions[field.key] + direction * field.step));
    apply({ ...conditions, [field.key]: Math.round(value * PERCENT) / PERCENT });
  };
  useBindings(
    () => ({
      bindings: [
        { key: "right", cmd: () => adjust(1), desc: "more", group: "panel" },
        { key: "left", cmd: () => adjust(-1), desc: "less", group: "panel" },
        { key: "l", cmd: () => adjust(1) },
        { key: "h", cmd: () => adjust(-1) },
        ...Object.entries(PRESETS).map(([key, preset]) => ({
          key,
          cmd: () => apply(preset.conditions),
          desc: preset.label,
          group: "panel",
        })),
      ],
    }),
    [conditions, field],
  );
  return (
    <box flexDirection="column" flexGrow={1} gap={1}>
      <box flexDirection="column" flexShrink={0}>
        {FIELDS.map((f, i) => {
          const value = conditions[f.key];
          return (
            <text
              key={f.key}
              height={1}
              wrapMode="none"
              truncate
              bg={i === list.index ? color.selected : undefined}
            >
              <span fg={color.muted}>{fit(f.label, LABEL)}</span>
              <span fg={value ? color.warn : color.text}>
                {f.unit === "p" ? `${Math.round(value * PERCENT)}%` : `${value} ms`}
              </span>
            </text>
          );
        })}
      </box>
      <Line fg={color.muted}>{status}</Line>
      <Line fg={color.faint}>
        Latency is added before each request is sent (on top of LUCIOLE_LATENCY_MS); the Network
        panel shows it as queued time.
      </Line>
    </box>
  );
}
