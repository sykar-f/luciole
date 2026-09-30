/** @jsxImportSource @opentui/react */
import { test, expect } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { TextareaRenderable } from "@opentui/core";
import { MouseButtons, type MouseButton } from "@opentui/core/testing";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../packages/luciole/src/build";
import {
  launch,
  until,
  importClient,
  destroy,
  draftOf,
  metricsOf,
  renderable,
  clickOn,
  type TestUI,
} from "./helpers";
const appDir = resolve("examples/notes");

async function start(tag: string, env: Record<string, string> = {}) {
  await build(appDir);
  const folder = await mkdtemp(join(tmpdir(), "luciole-notes-"));
  const server = await launch(join(appDir, ".luciole/server/index.js"), {
    NOTES_DB: join(folder, "notes.sqlite"),
    // Saves only when asked: the requests counted below are the test's own.
    NOTES_AUTOSAVE_MS: "0",
    ...env,
  });
  const { createApp, Shell } = await importClient(appDir, tag);
  const app = createApp({ url: server.url });
  await app.router.load();
  const ui = await testRender(<Shell app={app} />, { width: 110, height: 32 });
  return {
    app,
    ui,
    server,
    stop: async () => {
      await destroy(ui);
      await server.stop();
      await rm(folder, { recursive: true, force: true });
    },
  };
}
const path = (app: { router: { state: { resolvedLocation?: { pathname: string } } } }) =>
  app.router.state.resolvedLocation?.pathname;
const frame = async (ui: TestUI) => {
  await ui.renderOnce();
  return ui.captureCharFrame();
};
/** Clicks inside `act()`, then lets the effects and requests it started settle. */
const click = (ui: TestUI, text: string, button?: MouseButton) =>
  act(async () => {
    await clickOn(ui, text, button);
    await Bun.sleep(30);
  });

test("generated Notes: Flight action, preserved Draft, navigation and offline editing", async () => {
  const { app, ui, server, stop } = await start("notes", { NOTES_DELAY_MS: "400" });
  try {
    expect(server.pid).not.toBe(process.pid);
    // The list is read through a Server Function by the persistent layout.
    await act(async () => until(() => ui.captureCharFrame().includes("Shopping list")));
    await click(ui, "Welcome to Notes");
    await act(async () => until(() => path(app) === "/notes/1"));
    // Read as Markdown: headings without their markers, and nothing to type into.
    expect(await frame(ui)).toContain("Getting around");
    expect(await frame(ui)).not.toContain("## Getting around");
    await click(ui, "✎ Edit");
    const input = (id: string) => renderable(ui, id, TextareaRenderable);
    const field = input("note-1");
    const seed = field.plainText;
    expect(seed).toContain("## Getting around");
    await act(async () => {
      await ui.mockInput.typeText("abc");
    });
    const counts = () => metricsOf(server);
    const before = await counts();
    await act(async () => {
      ui.mockInput.pressKey("s", { ctrl: true });
    });
    await act(async () => {
      await ui.mockInput.typeText("d");
    });
    expect(field.plainText).toBe(`${seed}abcd`);
    const draft = draftOf(app, "1");
    expect(draft.pending?.value).toBe(`${seed}abc`);
    expect(await frame(ui)).toContain("Saving…");
    await act(async () => {
      await until(() => !draft.pending);
      await Bun.sleep(50);
    });
    expect(draft.baseline).toBe(`${seed}abc`);
    expect(draft.value).toBe(`${seed}abcd`);
    expect(draft.dirty).toBe(true);
    expect(draft.version).toBe(2);
    expect(input("note-1")).toBe(field);
    expect(await frame(ui)).toContain("Edited");
    // The save, then the list read again because the save invalidated it.
    await act(async () => {
      for (let i = 0; i < 50 && (await counts()).actions - before.actions < 2; i++)
        await Bun.sleep(10);
    });
    expect((await counts()).actions - before.actions).toBe(2);

    // The layout, and the list in it, persist from one note to another.
    const sidebar = ui.renderer.root.findDescendantById("sidebar");
    await click(ui, "Shopping list");
    await act(async () => until(() => path(app) === "/notes/2"));
    expect(ui.renderer.root.findDescendantById("sidebar")).toBe(sidebar);
    expect(input("note-2").plainText).toContain("Coffee beans");
    // Unsaved work is marked in the list, whatever note is shown.
    expect(await frame(ui)).toContain("●");
    await click(ui, "Welcome to Notes");
    await act(async () => until(() => path(app) === "/notes/1"));
    expect(input("note-1").plainText).toBe(`${seed}abcd`);

    const localBefore = await counts();
    await click(ui, "✎ Edit");
    await act(async () => {
      await ui.mockInput.typeText("e");
      ui.mockInput.pressArrow("left");
      ui.mockInput.pressArrow("right");
      const currentField = input("note-1");
      currentField.blur();
      currentField.focus();
      await ui.mockMouse.scroll(currentField.x, currentField.y, "down");
    });
    expect(await counts()).toEqual(localBefore);
    await server.stop();
    await act(async () => {
      await app.refresh();
      await ui.mockInput.typeText("f");
      // refresh() resolves once the router starts reloading, not once the request
      // fails: on a loaded machine, the refused connection reports a little later.
      await until(() => app.status === "Disconnected");
    });
    expect(input("note-1").plainText).toBe(`${seed}abcdef`);
    expect(await frame(ui)).toContain("Reconnect");
  } finally {
    await stop();
  }
});

test("every action is a click: new, rename, search, fold, delete and undo", async () => {
  const { app, ui, server, stop } = await start("notes-pointer");
  try {
    await act(async () => until(() => ui.captureCharFrame().includes("Shopping list")));
    expect(await frame(ui)).toContain("No note selected");
    // No shortcut is ever written on screen.
    expect(await frame(ui)).not.toMatch(/ctrl\+|Ctrl\+|Esc /);

    // A new note opens with its title ready to type; Return moves on to the text.
    await click(ui, "+ New note");
    await act(async () => until(() => /^\/notes\/[0-9a-f]{8}$/.test(path(app) ?? "")));
    const id = path(app)?.split("/").at(-1) ?? "";
    await act(async () => {
      await ui.mockInput.typeText("Plans");
      ui.mockInput.pressEnter();
    });
    await act(async () => {
      await ui.mockInput.typeText("- **one**");
    });
    await click(ui, "✓ Done");
    await act(async () => until(() => !draftOf(app, id).dirty && !draftOf(app, id).pending));
    await act(async () => until(() => ui.captureCharFrame().includes("✓ Saved")));
    const shown = await frame(ui);
    // Rendered, and listed under its new title at the top.
    expect(shown).toContain("- one");
    expect(shown).not.toContain("**one**");
    expect(shown.indexOf("Plans")).toBeLessThan(shown.indexOf("Welcome to Notes"));

    // Search narrows the list; the ✕ in the box clears it.
    await click(ui, "Search");
    await act(async () => {
      await ui.mockInput.typeText("coffee");
    });
    expect(await frame(ui)).toContain("1 of 3 notes");
    expect(await frame(ui)).not.toContain("Welcome to Notes");
    await click(ui, "✕");
    expect(await frame(ui)).toContain("Welcome to Notes");

    // The list folds away and comes back.
    await click(ui, "◧ Hide list");
    expect(ui.renderer.root.findDescendantById("sidebar")).toBeUndefined();
    await click(ui, "◧ Show list");
    expect(ui.renderer.root.findDescendantById("sidebar")).toBeDefined();

    // A right click on a note offers its menu; Rename… opens its title.
    await click(ui, "Shopping list", MouseButtons.RIGHT);
    expect(await frame(ui)).toContain("Rename…");
    await click(ui, "Rename…");
    await act(async () => until(() => path(app) === "/notes/2"));
    await act(async () => until(() => !!ui.renderer.root.findDescendantById("title-field")));
    await act(async () => {
      await ui.mockInput.typeText(" (week)");
      ui.mockInput.pressEnter();
    });
    await act(async () => until(() => ui.captureCharFrame().includes("Shopping list (week)")));

    // Saved elsewhere while this Client edits (Return left the title for the text): its
    // text is kept, and "Keep mine" wins.
    expect(await frame(ui)).toContain("✓ Done");
    await act(async () => {
      await ui.mockInput.typeText("mine");
    });
    const draft = draftOf(app, "2");
    await act(async () => {
      await app.callServer(`${server.buildId}/actions/notes.ts#saveNote`, [
        { id: "2", value: "theirs", version: 1, revision: 0, operationId: crypto.randomUUID() },
      ]);
      await until(() => ui.captureCharFrame().includes("Your text is kept here"));
    });
    expect(draft.value.endsWith("mine")).toBe(true);
    await click(ui, "Keep mine");
    await act(async () => until(() => !draft.pending && !draft.dirty));
    expect(draft.version).toBe(3);
    expect(draft.baseline.endsWith("mine")).toBe(true);

    // Deleted at once, with an Undo that brings it back.
    await click(ui, "Plans");
    await act(async () => until(() => path(app) === `/notes/${id}`));
    await click(ui, "Delete");
    await act(async () => until(() => ui.captureCharFrame().includes("Deleted “Plans”")));
    expect(path(app)).not.toBe(`/notes/${id}`);
    expect(await frame(ui)).toContain("2 notes");
    await click(ui, "Undo");
    await act(async () => until(() => path(app) === `/notes/${id}`));
    await act(async () => until(() => ui.captureCharFrame().includes("3 notes")));
  } finally {
    await stop();
  }
});
