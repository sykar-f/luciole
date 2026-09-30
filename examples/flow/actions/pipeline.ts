"use server";
import { z } from "zod";
import type { Link, Pipeline, Result, Run, Step } from "../components/model";
import { pipeline } from "../server/pipeline";

// Arguments arrive decoded but unchecked: each one is validated here.
const ID_MAX = 64;
const NAME_MAX = 200;
const MOVES_MAX = 100;
const COORDINATE_MAX = 100_000;
const Id = z.string().min(1).max(ID_MAX);
const Ids = z.array(Id).max(MOVES_MAX);
const Coordinate = z.number().int().min(-COORDINATE_MAX).max(COORDINATE_MAX);
const Moves = z.array(z.object({ id: Id, x: Coordinate, y: Coordinate })).max(MOVES_MAX);
const invalid = (what: string): { ok: false; error: string } => ({
  ok: false,
  error: `Invalid ${what}`,
});

/** The pipeline as the Server has it: after a change it refused, the Client starts over. */
export async function loadPipeline(): Promise<Pipeline> {
  return pipeline.snapshot();
}

/** Where steps were dropped (a drag's end, or keys that move them). */
export async function moveSteps(moves: unknown): Promise<Result> {
  const parsed = Moves.safeParse(moves);
  return parsed.success ? pipeline.move(parsed.data) : invalid("moves");
}

/** A new step, linked after `after` when given. */
export async function addStep(after: unknown): Promise<Result<{ step: Step; link: Link | null }>> {
  const parsed = Id.nullable().safeParse(after);
  return parsed.success ? pipeline.add(parsed.data) : invalid("step");
}

export async function renameStep(id: unknown, name: unknown): Promise<Result> {
  const i = Id.safeParse(id);
  const n = z.string().max(NAME_MAX).safeParse(name);
  return i.success && n.success ? pipeline.rename(i.data, n.data) : invalid("name");
}

export async function removeElements(steps: unknown, links: unknown): Promise<Result> {
  const s = Ids.safeParse(steps);
  const l = Ids.safeParse(links);
  return s.success && l.success ? pipeline.remove(s.data, l.data) : invalid("selection");
}

export async function connectSteps(from: unknown, to: unknown): Promise<Result<{ link: Link }>> {
  const f = Id.safeParse(from);
  const t = Id.safeParse(to);
  return f.success && t.success ? pipeline.connect(f.data, t.data) : invalid("link");
}

export async function startRun(): Promise<Result<{ number: number }>> {
  return pipeline.start();
}

/**
 * The run, now and at each change, as long as the Client watches. The argument only
 * renews the subscription after a drop.
 */
export async function* watchRun(_attempt: number): AsyncGenerator<Run> {
  const queue: Run[] = [];
  let wake: (() => void) | undefined;
  const stop = pipeline.subscribe((run) => {
    queue.push(run);
    wake?.();
  });
  try {
    for (;;) {
      const next = queue.shift();
      if (next) yield next;
      else await new Promise<void>((resolve) => (wake = resolve));
    }
  } finally {
    stop();
  }
}
