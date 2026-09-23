/** @jsxImportSource @opentui/react */
import { test, expect } from "bun:test";
import { act } from "react";
import { InputRenderable, Renderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../src/build";
import { launch, until, importClient, destroy, draftOf, renderable, type TestUI } from "./helpers";

test("local route loading, cancel, refresh identity, failed navigation and superseded loads", async () => {
  const directory = resolve("examples/notes");
  await build(directory);
  const temp = await mkdtemp(join(tmpdir(), "airtty-navigation-"));
  const server = await launch(join(directory, ".airtty/server/index.js"), {
    NOTES_DB: join(temp, "notes.sqlite"),
  });
  const { createApp, Shell } = await importClient(directory, "navigation");
  let gate: { promise: Promise<void>; signal?: AbortSignal } | undefined;
  function hold() {
    const deferred = Promise.withResolvers<void>();
    const next: PromiseWithResolvers<void> & { signal?: AbortSignal } = { ...deferred };
    gate = next;
    return next;
  }
  const app = createApp({
    url: server.url,
    fetch: async (url: URL, init: RequestInit) => {
      const currentGate = gate;
      gate = undefined;
      if (currentGate) {
        currentGate.signal = init.signal ?? undefined;
        await currentGate.promise;
        // Deliberately ignore cancellation: stale results must still be harmless.
        return fetch(url, { ...init, signal: undefined });
      }
      return fetch(url, init);
    },
  });
  let rendered: TestUI | undefined;
  const geometry = (ui: TestUI) =>
    Object.fromEntries(
      [
        "notes-heading",
        "notebook-heading",
        "note-heading",
        "note-field-frame",
        "note-status",
        "note-feedback",
        "note-help",
        "notes-footer",
      ].map((id) => {
        const node = renderable(ui, id, Renderable);
        return [id, [node.x, node.y, node.width, node.height]];
      }),
    );
  const resolved = () => app.router.state.resolvedLocation?.pathname;
  const pending = () => app.router.state.location.pathname;
  try {
    await app.router.load();
    const ui = await testRender(<Shell app={app} />, { width: 100, height: 28 });
    rendered = ui;
    const first = hold();
    let navigation: Promise<void> = Promise.resolve();
    await act(async () => {
      navigation = app.router.navigate({ to: "/notes/1" });
    });
    await ui.renderOnce();
    const loadingGeometry = geometry(ui);
    expect(resolved()).toBe("/");
    expect(pending()).toBe("/notes/1");
    expect(ui.captureCharFrame()).toContain("Opening note 1");
    expect(ui.captureCharFrame()).toContain("Esc cancel");
    expect(ui.renderer.root.findDescendantById("notes")).toBeUndefined();
    expect(ui.renderer.root.findDescendantById("note-1")).toBeUndefined();
    // Refresh during a navigation restarts the destination, never the old page.
    const restarted = hold();
    let retried: Promise<void> = Promise.resolve();
    await act(async () => {
      retried = app.refresh();
    });
    expect(pending()).toBe("/notes/1");
    expect(first.signal?.aborted).toBe(true);
    await act(async () => {
      first.resolve();
      await Bun.sleep(20);
    });
    expect(pending()).toBe("/notes/1");
    expect(resolved()).toBe("/");
    await act(async () => {
      ui.mockInput.pressEscape();
      await until(() => app.router.state.status === "idle");
    });
    expect(resolved()).toBe("/");
    expect(pending()).toBe("/");
    expect(restarted.signal?.aborted).toBe(true);
    await act(async () => {
      restarted.resolve();
      await Promise.allSettled([navigation, retried]);
      await Bun.sleep(20);
    });
    await ui.renderOnce();
    expect(resolved()).toBe("/");
    expect(ui.renderer.root.findDescendantById("notes")).toBeDefined();
    expect(app.status).toBe("Connected");
    await act(async () => {
      await app.router.navigate({ to: "/notes/1" });
      await ui.mockInput.typeText("draft");
    });
    await ui.renderOnce();
    expect(geometry(ui)).toEqual(loadingGeometry);
    const field = renderable(ui, "note-1", InputRenderable);
    const refresh = hold();
    let refreshing: Promise<void> = Promise.resolve();
    await act(async () => {
      refreshing = app.refresh();
      await ui.mockInput.typeText("!");
    });
    await ui.renderOnce();
    expect(geometry(ui)).toEqual(loadingGeometry);
    expect(ui.captureCharFrame()).toContain("Refreshing");
    expect(ui.captureCharFrame()).not.toContain("Opening note");
    expect(ui.renderer.root.findDescendantById("note-1")).toBe(field);
    expect(field.value).toBe("draft!");
    await act(async () => {
      refresh.resolve();
      await refreshing;
    });
    expect(ui.renderer.root.findDescendantById("note-1")).toBe(field);
    // A save confirmed during a navigation: the editor's refresh restarts the destination.
    const saving = hold();
    await act(async () => {
      ui.mockInput.pressEnter();
    });
    const draft = draftOf(app, "1");
    const held = hold();
    await act(async () => {
      navigation = app.router.navigate({ to: "/notes/2" });
    });
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("Opening note 2");
    await act(async () => {
      saving.resolve();
      await until(() => !draft.pending);
      await until(() => app.router.state.status === "idle");
    });
    expect(held.signal?.aborted).toBe(true);
    expect(resolved()).toBe("/notes/2");
    expect(draft.version).toBe(2);
    await act(async () => {
      held.resolve(); // the superseded response is ignored
      await navigation;
    });
    expect(resolved()).toBe("/notes/2");
    // A failed navigation shows its error in the page slot; layouts stay mounted.
    const failure = hold();
    await act(async () => {
      navigation = app.router.navigate({ to: "/notes/1" });
      failure.reject(new Error("offline"));
      await navigation;
      await until(() => app.router.state.status === "idle");
    });
    await ui.renderOnce();
    expect(resolved()).toBe("/notes/1");
    expect(ui.captureCharFrame()).toContain("offline");
    expect(ui.captureCharFrame()).toContain("Personal notebook");
    expect(app.status).toBe("Disconnected");
    expect(draft.version).toBe(2);
    expect(draft.baseline).toBe("draft!");
    // Ctrl+R retries the destination; the Draft outlives its unmounted editor.
    await act(async () => {
      await app.refresh();
      await until(() => !!ui.renderer.root.findDescendantById("note-1"));
    });
    expect(renderable(ui, "note-1", InputRenderable).value).toBe("draft!");
    // The latest navigation wins over a slower refresh that fails later.
    const stale = hold();
    let old: Promise<void> = Promise.resolve();
    await act(async () => {
      old = app.refresh();
    });
    const latest = hold();
    await act(async () => {
      navigation = app.router.navigate({ to: "/notes/2" });
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
    expect(resolved()).toBe("/notes/2");
    expect(app.router.state.status).toBe("idle");
    expect(app.error).toBe("");
    expect(app.status).toBe("Connected");
    ui.resize(44, 28);
    const narrow = hold();
    await act(async () => {
      navigation = app.router.navigate({ to: "/notes/1" });
    });
    await ui.renderOnce();
    const narrowGeometry = geometry(ui);
    await act(async () => {
      narrow.resolve();
      await navigation;
      await ui.mockInput.typeText("x".repeat(100));
    });
    await ui.renderOnce();
    expect(geometry(ui)).toEqual(narrowGeometry);
  } finally {
    await destroy(rendered);
    await server.stop();
    await rm(temp, { recursive: true, force: true });
  }
});
