import "server-only";
import type { Link, Pipeline, Result, Run, Step, StepRun } from "../components/model";

/**
 * One pipeline, in the Server's memory: its steps, their links, and the runs. A run is
 * simulated: each step takes its time, starts when every upstream step passed, and the
 * steps after a failure are skipped. Every Client watching sees the same run.
 */

const TICK_MS = 100;
// FLOW_RUN_SCALE < 1 shortens runs (the PTY journey uses it).
const MIN_SCALE = 0.01;
const SCALE = Math.max(MIN_SCALE, Number(process.env.FLOW_RUN_SCALE ?? "1") || 1);
const BASE_MS = 1200;
const MS_PER_LETTER = 350;
const MAX_STEPS = 60;
const NAME_MAX = 24;
const NEXT_COLUMN = 20;
const NEW_ROW = 2;
// A step's box on the canvas (components/StepNode.tsx), for placing new ones.
const STEP_WIDTH = 16;
const STEP_HEIGHT = 4;

const seed = (): Pipeline => ({
  name: "web · main",
  steps: [
    {
      id: "checkout",
      name: "checkout",
      command: "git clone --depth 1",
      kind: "source",
      x: 0,
      y: 7,
    },
    {
      id: "install",
      name: "install",
      command: "bun install --frozen-lockfile",
      kind: "step",
      x: 20,
      y: 7,
    },
    {
      id: "checks",
      name: "checks",
      command: "",
      kind: "group",
      x: 40,
      y: 0,
      width: 20,
      height: 19,
    },
    {
      id: "lint",
      name: "lint",
      command: "bun run lint",
      kind: "step",
      x: 2,
      y: 1,
      parent: "checks",
    },
    {
      id: "typecheck",
      name: "typecheck",
      command: "bun run check",
      kind: "step",
      x: 2,
      y: 7,
      parent: "checks",
    },
    { id: "test", name: "test", command: "bun test", kind: "step", x: 2, y: 13, parent: "checks" },
    { id: "build", name: "build", command: "bun run build", kind: "step", x: 64, y: 7 },
    { id: "e2e", name: "e2e", command: "bun run test:e2e", kind: "step", x: 84, y: 2, flaky: true },
    {
      id: "staging",
      name: "staging",
      command: "deploy --env staging",
      kind: "deploy",
      x: 84,
      y: 12,
    },
    {
      id: "production",
      name: "production",
      command: "deploy --env prod",
      kind: "deploy",
      x: 104,
      y: 7,
    },
  ],
  links: [
    { id: "checkout->install", from: "checkout", to: "install" },
    { id: "install->lint", from: "install", to: "lint" },
    { id: "install->typecheck", from: "install", to: "typecheck" },
    { id: "install->test", from: "install", to: "test" },
    { id: "lint->build", from: "lint", to: "build" },
    { id: "typecheck->build", from: "typecheck", to: "build" },
    { id: "test->build", from: "test", to: "build" },
    { id: "build->e2e", from: "build", to: "e2e" },
    { id: "build->staging", from: "build", to: "staging" },
    { id: "e2e->production", from: "e2e", to: "production", label: "main" },
    { id: "staging->production", from: "staging", to: "production" },
  ],
});

type Listener = (run: Run) => void;

class PipelineServer {
  private pipeline = seed();
  private run: Run = { number: 0, state: "idle", steps: {} };
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly listeners = new Set<Listener>();
  private nextId = 1;

  snapshot(): Pipeline {
    return structuredClone(this.pipeline);
  }
  currentRun(): Run {
    return structuredClone(this.run);
  }

  // ── Changes ─────────────────────────────────────────────────────────────
  move(moves: readonly { id: string; x: number; y: number }[]): Result {
    for (const move of moves) {
      const step = this.step(move.id);
      if (!step) return { ok: false, error: `No step ${move.id}` };
      step.x = move.x;
      step.y = move.y;
    }
    return { ok: true };
  }

  /** A new step after `after` (linked to it), or on its own. */
  add(after: string | null): Result<{ step: Step; link: Link | null }> {
    if (this.pipeline.steps.length >= MAX_STEPS) return { ok: false, error: "Too many steps" };
    const from = after ? this.step(after) : undefined;
    if (after && (!from || from.kind === "group")) return { ok: false, error: `No step ${after}` };
    const id = `step-${this.nextId++}`;
    const origin = from ? this.absolute(from) : { x: 0, y: 0 };
    const x = origin.x + (from ? NEXT_COLUMN : 0);
    const step: Step = {
      id,
      name: `step ${this.nextId - 1}`,
      command: "echo todo",
      kind: "step",
      x,
      y: this.freeRow(x, origin.y),
    };
    this.pipeline.steps.push(step);
    const link = from ? { id: `${from.id}->${id}`, from: from.id, to: id } : null;
    if (link) this.pipeline.links.push(link);
    return { ok: true, step: structuredClone(step), link };
  }

  rename(id: string, name: string): Result {
    const step = this.step(id);
    const trimmed = name.trim().slice(0, NAME_MAX);
    if (!step) return { ok: false, error: `No step ${id}` };
    if (!trimmed) return { ok: false, error: "A step needs a name" };
    step.name = trimmed;
    return { ok: true };
  }

  /** Removes steps (a group with its steps) and links; the links of a removed step go too. */
  remove(steps: readonly string[], links: readonly string[]): Result {
    if (this.run.state === "running") return { ok: false, error: "Wait for the run to end" };
    const gone = new Set(steps);
    for (const s of this.pipeline.steps) if (s.parent && gone.has(s.parent)) gone.add(s.id);
    const cut = new Set(links);
    this.pipeline.steps = this.pipeline.steps.filter((s) => !gone.has(s.id));
    this.pipeline.links = this.pipeline.links.filter(
      (l) => !cut.has(l.id) && !gone.has(l.from) && !gone.has(l.to),
    );
    return { ok: true };
  }

  /** Links two steps, unless the link exists, involves a group, or closes a cycle. */
  connect(from: string, to: string): Result<{ link: Link }> {
    const a = this.step(from);
    const b = this.step(to);
    if (!a || !b || a.kind === "group" || b.kind === "group")
      return { ok: false, error: "Only steps can be linked" };
    if (from === to) return { ok: false, error: "A step cannot depend on itself" };
    const id = `${from}->${to}`;
    if (this.pipeline.links.some((l) => l.id === id)) return { ok: false, error: "Already linked" };
    if (this.reaches(to, from)) return { ok: false, error: `${b.name} already leads to ${a.name}` };
    const link = { id, from, to };
    this.pipeline.links.push(link);
    return { ok: true, link };
  }

  // ── Runs ────────────────────────────────────────────────────────────────
  start(): Result<{ number: number }> {
    if (this.run.state === "running") return { ok: false, error: "A run is already going" };
    const steps: Record<string, StepRun> = {};
    for (const s of this.pipeline.steps)
      if (s.kind !== "group") steps[s.id] = { status: "queued", progress: 0, ms: 0 };
    this.run = { number: this.run.number + 1, state: "running", steps };
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.publish();
    return { ok: true, number: this.run.number };
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    listener(this.currentRun());
    return () => this.listeners.delete(listener);
  }

  private tick() {
    const run = this.run;
    const upstream = (id: string) =>
      this.pipeline.links.filter((l) => l.to === id).map((l) => l.from);
    for (const step of this.pipeline.steps) {
      const state = run.steps[step.id];
      if (!state) continue;
      const before = upstream(step.id).map((id) => run.steps[id]?.status ?? "passed");
      if (state.status === "queued") {
        if (before.some((s) => s === "failed" || s === "skipped")) state.status = "skipped";
        else if (before.every((s) => s === "passed")) state.status = "running";
      } else if (state.status === "running") {
        state.ms += TICK_MS;
        const total = (BASE_MS + step.name.length * MS_PER_LETTER) * SCALE;
        state.progress = Math.min(1, state.ms / total);
        if (state.progress >= 1)
          state.status = step.flaky && run.number % 2 === 1 ? "failed" : "passed";
      }
    }
    const all = Object.values(run.steps);
    if (all.every((s) => s.status !== "queued" && s.status !== "running")) {
      run.state = all.some((s) => s.status === "failed") ? "failed" : "passed";
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.publish();
  }

  private publish() {
    for (const listener of this.listeners) listener(this.currentRun());
  }

  private step(id: string) {
    return this.pipeline.steps.find((s) => s.id === id);
  }
  private absolute(step: Step) {
    const parent = step.parent ? this.step(step.parent) : undefined;
    return { x: step.x + (parent?.x ?? 0), y: step.y + (parent?.y ?? 0) };
  }
  /** The first row from `y` down where a step at column `x` overlaps nothing. */
  private freeRow(x: number, y: number) {
    const boxes = this.pipeline.steps.map((s) => ({
      ...this.absolute(s),
      width: s.width ?? STEP_WIDTH,
      height: s.height ?? STEP_HEIGHT,
    }));
    const overlaps = (row: number) =>
      boxes.some(
        (b) =>
          b.x < x + STEP_WIDTH &&
          x < b.x + b.width &&
          b.y < row + STEP_HEIGHT + 1 &&
          row < b.y + b.height + 1,
      );
    let row = y;
    while (overlaps(row)) row += NEW_ROW;
    return row;
  }
  private reaches(from: string, to: string): boolean {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === undefined || seen.has(id)) continue;
      if (id === to) return true;
      seen.add(id);
      for (const l of this.pipeline.links) if (l.from === id) stack.push(l.to);
    }
    return false;
  }
}

export const pipeline = new PipelineServer();
