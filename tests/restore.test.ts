import { expect, test } from "bun:test";
import { createMemoryHistory } from "@tanstack/react-router";
import { MAX_ENTRIES, Restoration } from "../packages/core/src/restore";

function session(entries = ["/"]) {
  const history = createMemoryHistory({ initialEntries: entries });
  const restoration = new Restoration();
  // The Application syncs on every router navigation; here, on every history change.
  restoration.sync(history);
  history.subscribe(() => restoration.sync(history));
  return { history, restoration, here: () => restoration.place(history) };
}
const typed = { typed: true },
  set = { typed: false };

test("text belongs to its history entry: back restores it, a new page starts empty", () => {
  const { history, restoration, here } = session();
  history.push("/notes/1");
  const note = here();
  restoration.save(note, "note/text", "abc", typed);
  history.push("/notes/2");
  expect(restoration.get(here(), "note/text")).toBeUndefined();
  history.back();
  expect(restoration.get(here(), "note/text")).toBe("abc");
  // A push after going back replaces the forward entries, and their text.
  history.back();
  history.push("/notes/3");
  history.back();
  history.push("/notes/1");
  expect(restoration.get(here(), "note/text")).toBeUndefined();
});

test("a replace keeps the text of the same address, not of another page", () => {
  const { history, restoration, here } = session(["/notes/1"]);
  restoration.save(here(), "note/text", "abc", typed);
  history.replace("/notes/1");
  expect(restoration.get(here(), "note/text")).toBe("abc");
  history.replace("/login");
  history.replace("/notes/1");
  expect(restoration.get(here(), "note/text")).toBeUndefined();
});

test("a field keeps writing to the entry it was mounted in", () => {
  const { history, restoration, here } = session(["/a"]);
  const mounted = here();
  history.push("/b");
  restoration.save(mounted, "f", "typed on /a", typed);
  expect(restoration.get(here(), "f")).toBeUndefined();
  history.back();
  expect(restoration.get(here(), "f")).toBe("typed on /a");
});

test("values set by the application only follow text that was typed", () => {
  const { restoration, here } = session();
  restoration.save(here(), "f", "loaded from the Server", set);
  expect(restoration.get(here(), "f")).toBeUndefined();
  restoration.save(here(), "f", "typed", typed);
  restoration.save(here(), "f", "reset by the form", set);
  expect(restoration.get(here(), "f")).toBe("reset by the form");
  restoration.save(here(), "f", "", set);
  expect(restoration.get(here(), "f")).toBeUndefined();
});

test("a submit takes the group's text; only the user can bring it back, or a restore", () => {
  const { restoration, here } = session();
  restoration.save(here(), "pr/title", "Retry", typed);
  restoration.save(here(), "pr/body", "Backoff", typed);
  restoration.save(here(), "other", "kept", typed);
  const taken = restoration.take(here(), "pr");
  expect(taken).toEqual({ "pr/title": "Retry", "pr/body": "Backoff" });
  expect(restoration.snapshot().entries[0].fields).toEqual({ other: "kept" });
  // The field still shows the sent value: the application setting it saves nothing.
  restoration.save(here(), "pr/title", "Retry", set);
  expect(restoration.get(here(), "pr/title")).toBeUndefined();
  // Typing during the request is new work.
  restoration.save(here(), "pr/body", "Backoff and jitter", typed);
  // The request never ran: the sent text comes back, newer typing wins.
  restoration.restore(here(), taken);
  expect(restoration.get(here(), "pr/title")).toBe("Retry");
  expect(restoration.get(here(), "pr/body")).toBe("Backoff and jitter");
});

test("clear forgets every field but keeps the history", () => {
  const { history, restoration, here } = session();
  history.push("/notes/1");
  restoration.save(here(), "note/text", "abc", typed);
  restoration.clear();
  expect(restoration.snapshot()).toEqual({
    index: 1,
    entries: [
      { href: "/", fields: {} },
      { href: "/notes/1", fields: {} },
    ],
  });
});

test("a snapshot restores the same session, capped to the latest entries", () => {
  const { history, restoration, here } = session();
  for (let i = 1; i <= MAX_ENTRIES + 5; i++) history.push(`/notes/${i}`);
  restoration.save(here(), "note/text", "last", typed);
  const saved = restoration.snapshot();
  expect(saved.entries).toHaveLength(MAX_ENTRIES);
  expect(saved.index).toBe(MAX_ENTRIES - 1);
  const again = new Restoration(saved);
  const restored = createMemoryHistory({ initialEntries: saved.entries.map((e) => e.href) });
  restored.subscribe(() => again.sync(restored));
  expect(again.get(again.place(restored), "note/text")).toBe("last");
});

test("the focus and the scroll boxes belong to their history entry, like the text", () => {
  const { history, restoration, here } = session(["/"]);
  history.push("/form");
  const form = here();
  restoration.focus(form, "post/body");
  restoration.scroll(form, "post/preview", 12);
  history.push("/other");
  expect(restoration.focused(here())).toBeUndefined();
  expect(restoration.scrolled(here(), "post/preview")).toBeUndefined();
  history.back();
  expect(restoration.focused(here())).toBe("post/body");
  expect(restoration.scrolled(here(), "post/preview")).toBe(12);
  // Back at the top: nothing to keep.
  restoration.scroll(form, "post/preview", 0);
  expect(restoration.snapshot().entries[1]).toEqual({
    href: "/form",
    fields: {},
    focus: "post/body",
  });
});

test("clear forgets the typed text only: the focus and the scroll positions stay", () => {
  const { restoration, here } = session(["/form"]);
  restoration.save(here(), "post/title", "abc", typed);
  restoration.focus(here(), "post/title");
  restoration.scroll(here(), "post/list", 3);
  restoration.clear();
  const again = new Restoration(restoration.snapshot());
  const restored = createMemoryHistory({ initialEntries: ["/form"] });
  expect(again.get(again.place(restored), "post/title")).toBeUndefined();
  expect(again.focused(again.place(restored))).toBe("post/title");
  expect(again.scrolled(again.place(restored), "post/list")).toBe(3);
});
