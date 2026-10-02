/**
 * studio's scripted generator paces the drafts of a turn: by a pause, or, with
 * STUDIO_FAKE_GATE_DIR, until whoever watches the preview has seen each one (it creates
 * the file `draft-<n>`). The tests follow the generator's events, never a duration.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEvent } from "@luciole/harness/adapters/types";
import { Generator } from "../examples/studio/server/generator";
import { SCENARIOS } from "../examples/studio/server/scenarios";

const scenario = (name: string) => {
  const found = SCENARIOS.find((s) => s.name === name);
  if (!found) throw new Error(`no scenario ${name}`);
  return found;
};
const guestbook = scenario("guestbook");
const signatures = scenario("signatures");

let directory: string;
let project: string;
let gate: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "luciole-generator-"));
  project = join(directory, "project");
  gate = join(directory, "gate");
  mkdirSync(project);
  mkdirSync(gate);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

/** A generator on its events, and a way to wait for a moment of them. */
async function start(env: Record<string, string>) {
  const events: HarnessEvent[] = [];
  const watchers = new Set<() => void>();
  const generator = new Generator({
    env: { STUDIO_FAKE_DELAY_MS: "0", ...env },
    emit: (event) => {
      events.push(event);
      for (const watcher of watchers) watcher();
    },
  });
  await generator.start({ cwd: project, mode: "edits" });
  const count = (type: "file_change" | "completed") =>
    events.filter((e) =>
      type === "completed"
        ? e.type === "turn.completed"
        : e.type === "item.completed" && e.item.kind === "file_change",
    ).length;
  /** Resolves once `ready` holds, as of an event. */
  const until = (ready: () => boolean) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (!ready()) return;
        watchers.delete(check);
        resolve();
      };
      watchers.add(check);
      check();
    });
  return { generator, events, count, until };
}

const release = (n: number) => writeFileSync(join(gate, `draft-${n}`), "");
const drafts = guestbook.drafts?.length ?? 0;

test("a gated draft is held until its file exists, which the generator consumes", async () => {
  const { generator, count, until } = await start({ STUDIO_FAKE_GATE_DIR: gate });
  await generator.send({ text: guestbook.prompt });
  await until(() => count("file_change") === 1);
  // Held: the second draft's files are not written.
  expect(existsSync(join(project, "server/guestbook.ts"))).toBe(false);
  release(0);
  await until(() => count("file_change") === 2);
  expect(existsSync(join(gate, "draft-0"))).toBe(false);
  expect(existsSync(join(project, "server/guestbook.ts"))).toBe(true);
  for (let n = 1; n < drafts; n++) {
    release(n);
    await until(() => count("file_change") === n + 2);
    expect(existsSync(join(gate, `draft-${n}`))).toBe(false);
  }
  await until(() => count("completed") === 1);
  // The turn's own files came after its last draft was released.
  expect(count("file_change")).toBe(drafts + 1);
});

test("the numbering of the gate continues across turns", async () => {
  const { generator, count, until } = await start({ STUDIO_FAKE_GATE_DIR: gate });
  await generator.send({ text: guestbook.prompt });
  for (let n = 0; n < drafts; n++) {
    await until(() => count("file_change") === n + 1);
    release(n);
  }
  await until(() => count("completed") === 1);

  const before = count("file_change");
  await generator.send({ text: signatures.prompt });
  await until(() => count("file_change") === before + 1);
  // The first draft of the second turn waits for the next number, not for draft-0.
  expect(existsSync(join(gate, `draft-${drafts}`))).toBe(false);
  release(drafts);
  await until(() => count("completed") === 2);
  expect(existsSync(join(gate, `draft-${drafts}`))).toBe(false);
  expect(count("file_change")).toBe(before + 2);
});

test("interrupt ends a held wait: nothing is written after it", async () => {
  const { generator, count, until } = await start({ STUDIO_FAKE_GATE_DIR: gate });
  await generator.send({ text: guestbook.prompt });
  await until(() => count("file_change") === 1);
  await generator.interrupt();
  await until(() => count("completed") === 1);
  release(0);
  expect(count("file_change")).toBe(1);
  expect(existsSync(join(project, "server/guestbook.ts"))).toBe(false);
});

test("close ends a held wait: nothing is written after it", async () => {
  const { generator, events, count, until } = await start({ STUDIO_FAKE_GATE_DIR: gate });
  await generator.send({ text: guestbook.prompt });
  await until(() => count("file_change") === 1);
  await generator.close();
  await until(() => count("completed") === 1);
  release(0);
  expect(count("file_change")).toBe(1);
  expect(existsSync(join(project, "server/guestbook.ts"))).toBe(false);
  expect(events.at(-1)).toEqual({ type: "turn.completed", status: "interrupted" });
});

test("without a gate, the drafts follow one another on the pause", async () => {
  const { generator, count, until } = await start({ STUDIO_FAKE_WRITE_MS: "1" });
  await generator.send({ text: guestbook.prompt });
  await until(() => count("completed") === 1);
  expect(count("file_change")).toBe(drafts + 1);
  expect(existsSync(join(project, "server/guestbook.ts"))).toBe(true);
});
