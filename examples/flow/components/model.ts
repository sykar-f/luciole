/** The pipeline as the Server keeps it and the Client draws it. */

export type StepKind = "source" | "step" | "deploy" | "group";

export type Step = {
  id: string;
  name: string;
  command: string;
  kind: StepKind;
  /** Cells; relative to `parent` when there is one. */
  x: number;
  y: number;
  /** A group this step sits in. */
  parent?: string;
  /** Size of a group, in cells. */
  width?: number;
  height?: number;
  /** Fails on odd runs: a flaky test suite, to show what a failure looks like. */
  flaky?: boolean;
};

export type Link = { id: string; from: string; to: string; label?: string };

export type Pipeline = { name: string; steps: Step[]; links: Link[] };

export type StepStatus = "idle" | "queued" | "running" | "passed" | "failed" | "skipped";
export type StepRun = { status: StepStatus; progress: number; ms: number };
export type Run = {
  number: number;
  state: "idle" | "running" | "passed" | "failed";
  steps: Record<string, StepRun>;
};

export type Result<T extends Record<string, unknown> = Record<never, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

export const IDLE: StepRun = { status: "idle", progress: 0, ms: 0 };

export const STATUS_ICON: Record<StepStatus, string> = {
  idle: "○",
  queued: "◌",
  running: "◐",
  passed: "✓",
  failed: "✗",
  skipped: "–",
};
