/** @jsxImportSource @opentui/react */
import { test, expect } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../src/build";
import { launch, until } from "./helpers";

test("local route loading, cancel, refresh identity, failure recovery and superseded navigation", async () => {
  const directory = resolve("examples/notes");
  await build(directory);
  const temp = await mkdtemp(join(tmpdir(), "terminal-navigation-"));
  const server = await launch(join(directory, ".terminal/server/index.js"), {
    NOTES_DB: join(temp, "notes.sqlite"),
  });
  const { createApp, Shell } = await import(
    join(directory, ".terminal/client/index.js") + "?navigation"
  );
  let gate: { promise: Promise<void>; signal?: AbortSignal } | undefined;
  function hold() {
    const deferred = Promise.withResolvers<void>();
    const next = { ...deferred, signal: undefined as AbortSignal | undefined };
    gate = next;
    return next;
  }
  const app = createApp({
    url: server.url,
    fetch: async (url: string, init: RequestInit) => {
      const currentGate = gate;
      gate = undefined;
      if (currentGate) {
        currentGate.signal = init.signal as AbortSignal;
        await currentGate.promise;
        // Deliberately ignore cancellation: stale results must still be harmless.
        return fetch(url, { ...init, signal: undefined });
      }
      return fetch(url, init);
    },
  });
  let ui: any;
  const geometry = () =>
    Object.fromEntries(
      [
        "terminal-heading",
        "notebook-heading",
        "note-heading",
        "note-field-frame",
        "note-status",
        "note-feedback",
        "note-help",
        "terminal-footer",
      ].map((id) => {
        const node = ui.renderer.root.findDescendantById(id);
        return [id, [node.x, node.y, node.width, node.height]];
      }),
    );
  try {
    await app.navigate("/");
    ui = await testRender(<Shell app={app} />, { width: 100, height: 28 });
    const first = hold();
    let navigation!: Promise<void>;
    await act(async () => {
      navigation = app.navigate("/notes/1");
    });
    await ui.renderOnce();
    const loadingGeometry = geometry();
    expect(app.path).toBe("/");
    expect(app.pendingNavigation).toEqual({ path: "/notes/1", kind: "navigate" });
    expect(ui.captureCharFrame()).toContain("Opening note 1");
    expect(ui.renderer.root.findDescendantById("notes")).toBeUndefined();
    expect(ui.renderer.root.findDescendantById("note-1")).toBeUndefined();
    const restarted = hold();
    let retried!: Promise<void>;
    await act(async () => {
      retried = app.refresh();
    });
    expect(app.pendingNavigation?.path).toBe("/notes/1");
    expect(first.signal?.aborted).toBe(true);
    await act(async () => {
      first.resolve();
      await navigation;
    });
    expect(app.pendingNavigation?.path).toBe("/notes/1");
    await act(async () => {
      await ui.mockInput.pressEscape();
      await until(() => app.pendingNavigation === null);
    });
    expect(app.pendingNavigation).toBeNull();
    expect(first.signal?.aborted).toBe(true);
    await act(async () => {
      restarted.resolve();
      await retried;
    });
    expect(app.path).toBe("/");
    expect(app.status).toBe("Connected");
    await act(async () => {
      await app.navigate("/notes/1");
      await ui.mockInput.typeText("draft");
    });
    await ui.renderOnce();
    expect(geometry()).toEqual(loadingGeometry);
    const field = ui.renderer.root.findDescendantById("note-1");
    const refresh = hold();
    await act(async () => {
      navigation = app.refresh();
      await ui.mockInput.typeText("!");
    });
    await ui.renderOnce();
    expect(geometry()).toEqual(loadingGeometry);
    expect(ui.captureCharFrame()).toContain("Refreshing");
    expect(ui.captureCharFrame()).not.toContain("Opening note");
    expect(ui.renderer.root.findDescendantById("note-1")).toBe(field);
    expect(field.value).toBe("draft!");
    await act(async () => {
      refresh.resolve();
      await navigation;
    });
    expect(ui.renderer.root.findDescendantById("note-1")).toBe(field);
    // A save may finish while the old editor is unmounted by a navigation.
    const saving = hold();
    await act(async () => {
      await ui.mockInput.pressEnter();
    });
    const draft = app.drafts.get({ id: "1" });
    const failure = hold();
    await act(async () => {
      navigation = app.navigate("/notes/2");
    });
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("Opening note 2");
    await act(async () => {
      saving.resolve();
      await until(() => !draft.pending);
    });
    expect(draft.version).toBe(2);
    await act(async () => {
      failure.reject(new Error("offline"));
      await navigation;
    });
    expect(app.path).toBe("/notes/1");
    expect(app.pendingNavigation).toBeNull();
    expect(app.error).toContain("offline");
    expect(ui.renderer.root.findDescendantById("note-1").value).toBe("draft!");
    expect(draft.version).toBe(2);
    expect(draft.baseline).toBe("draft!");
    const stale = hold();
    let old!: Promise<void>;
    await act(async () => {
      old = app.refresh();
    });
    const latest = hold();
    await act(async () => {
      navigation = app.navigate("/notes/2");
    });
    expect(stale.signal?.aborted).toBe(true);
    await act(async () => {
      latest.resolve();
      await navigation;
    });
    await act(async () => {
      stale.reject(new Error("late failure"));
      await old;
    });
    expect(app.path).toBe("/notes/2");
    expect(app.pendingNavigation).toBeNull();
    expect(app.error).toBe("");
    expect(app.status).toBe("Connected");
    ui.resize(44, 28);
    const narrow = hold();
    await act(async () => {
      navigation = app.navigate("/notes/1");
    });
    await ui.renderOnce();
    const narrowGeometry = geometry();
    await act(async () => {
      narrow.resolve();
      await navigation;
      await ui.mockInput.typeText("x".repeat(100));
    });
    await ui.renderOnce();
    expect(geometry()).toEqual(narrowGeometry);
  } finally {
    if (ui) await act(async () => ui.renderer.destroy());
    await server.stop();
    await rm(temp, { recursive: true, force: true });
  }
});
