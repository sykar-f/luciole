import { expect, test } from "bun:test";
import type { Item, Snapshot } from "../packages/harness/src/model";
import { FeedStore } from "../packages/harness/src/ui/store";

const snapshot = (items: readonly Item[]): Snapshot => ({
  state: "idle",
  info: { harness: "fake", poweredBy: "scripted demo", mode: "ask", cwd: "/", warnings: [] },
  items,
  requests: [],
  plan: [],
  usage: {},
  queued: [],
  error: null,
  capabilities: {
    steer: true,
    models: true,
    effort: true,
    modes: ["ask"],
    compact: true,
    resume: true,
    newSession: true,
    planMode: false,
    images: false,
  },
  models: [],
  commands: [],
});
const user = (id: string, text: string): Item => ({ id, kind: "user", text });

test("patches upsert items in place, keep unchanged ones, drop removed ones", () => {
  const a = user("a", "one"),
    b = user("b", "two");
  const store = new FeedStore(snapshot([]));
  const gaps: number[] = [];
  store.follow(0, [{ kind: "snapshot", seq: 0, snapshot: snapshot([a, b]) }], () => gaps.push(0));
  const c = user("c", "three"),
    b2 = user("b", "two!");
  store.follow(
    0,
    [
      { kind: "snapshot", seq: 0, snapshot: snapshot([a, b]) },
      { kind: "patch", seq: 1, items: [b2, c], removed: [], fields: { state: "running" } },
      { kind: "patch", seq: 2, items: [], removed: ["a"], fields: {} },
    ],
    () => gaps.push(1),
  );
  const current = store.get();
  expect(current.items.map((i) => i.id)).toEqual(["b", "c"]);
  expect(current.items[0]).toBe(b2);
  expect(current.state).toBe("running");
  // A missing update is reported, never guessed.
  store.follow(0, [{ kind: "patch", seq: 4, items: [a], removed: [], fields: {} }], () =>
    gaps.push(2),
  );
  expect(gaps).toEqual([2]);
  // A new subscription starts over from its snapshot.
  store.follow(1, [{ kind: "snapshot", seq: 0, snapshot: snapshot([a]) }], () => gaps.push(3));
  expect(store.get().items).toEqual([a]);
  expect(gaps).toEqual([2]);
});
