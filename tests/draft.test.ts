import { test, expect } from "bun:test";
import { Draft, DraftStore, type Note } from "../examples/notes/components/draft";
const note = (id = "1", value = "", version = 1): Note => ({
  id,
  title: "Note",
  value,
  version,
});
test("confirmation uses submitted baseline and preserves newer edit", () => {
  const d = new Draft("1", note());
  d.edit("abc");
  const s = d.begin();
  d.edit("abcd");
  d.confirm({
    ok: true,
    operationId: s.operationId,
    note: note("1", "abc", 2),
  });
  expect(d.value).toBe("abcd");
  expect(d.baseline).toBe("abc");
  expect(d.version).toBe(2);
  expect(d.dirty).toBe(true);
});
test("normalization only applies to unchanged identity/revision", () => {
  const d = new Draft("1", note());
  d.edit(" abc ");
  const s = d.begin();
  d.confirm({
    ok: true,
    operationId: s.operationId,
    note: note("2", "ABC", 2),
  });
  expect(d.pending).toBeDefined();
  d.confirm({
    ok: true,
    operationId: s.operationId,
    note: note("1", "abc", 2),
  });
  expect(d.value).toBe("abc");
  expect(d.dirty).toBe(false);
});
test("one pending operation, unknown retained, stale result ignored", () => {
  const d = new Draft("1", note());
  const s = d.begin();
  d.markUnknown();
  expect(() => d.begin()).toThrow();
  expect(() => d.discard(note())).toThrow();
  d.confirm({ ok: false, error: "bad", operationId: "old" });
  expect(d.pending).toEqual(s);
  d.confirm({ ok: false, error: "validation", operationId: s.operationId });
  expect(d.pending).toBeUndefined();
  expect(d.error).toBe("validation");
});
test("external changes never overwrite dirty Draft; explicit discard resolves conflict", () => {
  const d = new Draft("1", note());
  d.edit("local");
  d.receive(note("1", "remote", 2));
  expect(d.value).toBe("local");
  expect(d.conflict).toBe(true);
  d.discard(note("1", "remote", 2));
  expect(d.value).toBe("remote");
  expect(d.conflict).toBe(false);
});
test("bounded store retains dirty entries, evicts clean entries, refuses overflow", () => {
  const store = new DraftStore(2);
  const a = store.get(note("1"));
  a.edit("abc");
  store.get(note("2"));
  store.get(note("3")).edit("xyz");
  expect(store.get(note("1"))).toBe(a);
  expect(() => store.get(note("4"))).toThrow("capacity");
});
test("unsaved work is listed and clear forgets every Draft", () => {
  const store = new DraftStore(4);
  const clean = store.get(note("1"));
  const dirty = store.get(note("2"));
  dirty.edit("typed by alice");
  const pending = store.get(note("3"));
  pending.begin();
  expect(store.unsaved()).toEqual([dirty, pending]);
  expect(store.size).toBe(3);
  let notified = 0;
  store.subscribe(() => notified++);
  store.clear();
  expect(notified).toBe(1);
  expect(store.size).toBe(0);
  expect(store.unsaved()).toEqual([]);
  // The same document identity now starts from the Server value, not the old Draft.
  expect(store.get(note("2", "server", 1)).value).toBe("server");
  expect(store.get(note("1"))).not.toBe(clean);
});
test("a save the Server provably never ran fails without an unknown outcome", () => {
  const d = new Draft("1", note());
  d.edit("abc");
  d.begin();
  d.fail("Not saved: offline");
  expect(d.pending).toBeUndefined();
  expect(d.unknown).toBe(false);
  expect(d.dirty).toBe(true);
  expect(d.error).toBe("Not saved: offline");
  // A new attempt is allowed at once.
  expect(d.begin().value).toBe("abc");
});
