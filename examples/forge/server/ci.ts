import type { CheckStatus } from "../components/model";

// CI is simulated without a worker: a check's state is a pure function of its start
// time and the clock, so any render or stream can compute it and nothing runs hidden.
export const CHECK_NAMES = ["lint", "test", "build"] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

type Step = readonly [offsetMs: number, line: string];
const SCRIPTS: Record<CheckName, { steps: readonly Step[]; failure: readonly Step[] }> = {
  lint: {
    steps: [
      [0, "$ bun run lint"],
      [400, "oxlint 1.85.0 — checking 42 files"],
      [1100, "0 warnings, 0 errors"],
      [1400, "$ bun run format:check"],
      [1800, "All matched files use the configured style"],
    ],
    failure: [[1800, "src/refunds.ts:14:3 no-unused-vars 'retry' is never read"]],
  },
  test: {
    steps: [
      [0, "$ bun test --timeout 20000"],
      [600, "test/ledger.test.ts ........ 8 pass"],
      [1700, "test/refunds.test.ts ............ 12 pass"],
      [2900, "test/settlement.test.ts ...... 6 pass"],
      [4200, "test/currencies.test.ts .................... 20 pass"],
      [5200, "46 pass · 0 fail · 212 expect() calls"],
    ],
    failure: [
      [2900, "test/settlement.test.ts ....✗ 5 pass · 1 fail"],
      [3000, "  ✗ settlement stream emits chunks in order (timeout 5000 ms)"],
      [5200, "45 pass · 1 fail · 211 expect() calls"],
    ],
  },
  build: {
    steps: [
      [0, "$ bun run build"],
      [700, "Compiling route graph (12 routes)"],
      [1600, "Bundling server artefact…"],
      [2600, "Bundling client artefact…"],
      [3400, "Build ready: .terminal/client, .terminal/server"],
    ],
    failure: [[3400, "error: Server-only import in Client graph: bun:sqlite"]],
  },
};

export type CheckRow = {
  id: number;
  name: CheckName;
  attempt: number;
  started_at: number;
  fail_until: number;
};

const fails = (check: CheckRow) => check.attempt <= check.fail_until;

/** The lines of one attempt, with their offsets already scaled. */
export function script(check: CheckRow, scale: number): Step[] {
  const { steps, failure } = SCRIPTS[check.name];
  const lines = fails(check)
    ? [...steps.filter(([at]) => at < failure[0][0]), ...failure]
    : [...steps];
  const end = lines[lines.length - 1][0];
  const verdict = fails(check) ? "✗ failed" : "✓ passed";
  return [...lines, [end + 200, `${verdict} (attempt ${check.attempt})`] as const].map(
    ([at, line]) => [Math.round(at * scale), line] as const,
  );
}

export function durationOf(check: CheckRow, scale: number) {
  const lines = script(check, scale);
  return lines[lines.length - 1][0];
}

export function statusOf(check: CheckRow, now: number, scale: number): CheckStatus {
  const elapsed = now - check.started_at;
  if (elapsed < 0) return "queued";
  if (elapsed < durationOf(check, scale)) return "running";
  return fails(check) ? "failure" : "success";
}

const stamp = (ms: number) =>
  `[${String(Math.floor(ms / 60000)).padStart(2, "0")}:${((ms % 60000) / 1000).toFixed(1).padStart(4, "0")}]`;

/**
 * Yields each log line when the clock reaches it. A finished check yields its whole
 * log at once. Streamed to the Client as a Flight async iterable.
 */
export async function* streamLog(
  check: CheckRow,
  scale: number,
  now: () => number,
): AsyncGenerator<string> {
  for (const [at, line] of script(check, scale)) {
    const wait = check.started_at + at - now();
    if (wait > 0) await Bun.sleep(wait);
    yield `${stamp(at)} ${line}`;
  }
}
