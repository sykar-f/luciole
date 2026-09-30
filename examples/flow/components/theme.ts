import type { StepStatus } from "./model";

export const color = {
  text: "#e6edf3",
  muted: "#8b98a5",
  faint: "#4d5966",
  accent: "#67d9bc",
  border: "#4d5966",
  panel: "#161b22",
  running: "#79c0ff",
  passed: "#3fb950",
  failed: "#f85149",
  queued: "#d29922",
};

export const statusColor: Record<StepStatus, string> = {
  idle: color.border,
  queued: color.queued,
  running: color.running,
  passed: color.passed,
  failed: color.failed,
  skipped: color.faint,
};
