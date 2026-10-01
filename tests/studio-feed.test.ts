/**
 * studio's Server under a held boot: the conversation feed answers without waiting for it,
 * and the types of a revision are blamed on it only while the tree is still its own. No
 * duration stands for an event: the boot never ends, the checks are called by the test.
 */
import { beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = realpathSync(mkdtempSync(join(tmpdir(), "studio-feed-")));
void mock.module("../examples/studio/server/config", () => ({
  config: {
    harness: "fake",
    directory: join(directory, "demo"),
    preview: "process",
    fixes: 2,
    launch: "test",
  },
}));

const { studio } = await import("../examples/studio/server/studio");
const { feed } = await import("../examples/studio/actions/studio");

const failure = [{ file: "components/Format.tsx", line: 2, message: "Cannot find module" }];
const servers = { types: async () => failure };
const validation = () => studio.snapshot().validation;
/** A project whose working tree holds these changes beyond its last revision. */
const project = (changed: string[]) => ({
  changes: async () => new Map(changed.map((file) => [file, "x"])),
});

/** What the transcript was told, and what the harness was sent. */
const sent: string[] = [];
const notes: { level: string; text: string }[] = [];
beforeEach(() => {
  sent.length = notes.length = 0;
  const session = studio.session;
  session.send = async (text) => {
    sent.push(text);
    return { ok: true };
  };
  session.note = (level, text) => void notes.push({ level, text });
  const snapshot = session.snapshot.bind(session);
  session.snapshot = () => ({ ...snapshot(), state: "idle" });
});

test("the feed answers while the project is still opening", async () => {
  studio.open = () => new Promise<void>(() => {});
  // The boot never ends: the feed answers at once, or it never does.
  const answer = await Promise.race([
    feed(0).then(() => "answered"),
    new Promise((done) => setImmediate(() => done("held"))),
  ]);
  expect(answer).toBe("answered");
  const updates = (await feed(1))[Symbol.asyncIterator]();
  const first = await updates.next();
  expect(first.value).toMatchObject({ kind: "snapshot" });
  await updates.return?.();
});

test("a type failure of an older tree is not blamed on the revision", async () => {
  // The next turn already wrote a file: tsc read it, the revision did not hold it.
  await studio.checkTypes(project(["components/Format.tsx"]), servers, 0);
  expect(validation().state).not.toBe("failed");
  expect(notes).toEqual([]);
  expect(sent).toEqual([]);
});

test("a type failure of another revision is not blamed on the current one", async () => {
  await studio.checkTypes(project([]), servers, 1);
  expect(validation().state).not.toBe("failed");
  expect(sent).toEqual([]);
});

test("a type failure of the unchanged revision is still reported and corrected", async () => {
  await studio.checkTypes(project([]), servers, 0);
  expect(validation()).toMatchObject({ state: "failed", failed: "types" });
  expect(notes.some((n) => n.level === "error" && n.text.includes("Cannot find module"))).toBe(
    true,
  );
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("Cannot find module");
});
