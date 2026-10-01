/** @jsxImportSource @opentui/react */
import { test, expect } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { Renderable, TextRenderable } from "@opentui/core";
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
  markdownEditor,
  clickOn,
  renderable,
  type ClientOptions,
  type TestUI,
} from "./helpers";
const appDir = resolve("examples/notes");

async function start(
  tag: string,
  env: Record<string, string> = {},
  options: Omit<ClientOptions, "url"> = {},
) {
  await build(appDir);
  const folder = await mkdtemp(join(tmpdir(), "luciole-notes-"));
  const server = await launch(join(appDir, ".luciole/server/index.js"), {
    NOTES_DB: join(folder, "notes.sqlite"),
    // Saves only when asked: the requests counted below are the test's own.
    NOTES_AUTOSAVE_MS: "0",
    ...env,
  });
  const { createApp, Shell } = await importClient(appDir, tag);
  const app = createApp({ url: server.url, ...options });
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
/** Renders frames, which drive the timelines, until `check` holds. */
const untilRendered = async (ui: TestUI, check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++)
    await act(async () => {
      await ui.renderOnce();
      await Bun.sleep(10);
    });
  expect(check()).toBe(true);
};
/** What the line above the title says; nothing while saves go well. */
const status = (ui: TestUI) => {
  const node = ui.renderer.root.findDescendantById("note-status");
  return node instanceof TextRenderable ? node.plainText : "";
};
/** How long a save stays unmentioned (NoteEditor's QUIET_MS). */
const QUIET_MS = 3000;
/**
 * Waits for `check`, one short `act()` at a time: timers' state updates apply when an
 * `act()` ends, not within one.
 */
async function eventually(check: () => boolean, timeout = 5000) {
  const deadline = performance.now() + timeout;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("Condition timed out");
    await act(async () => {
      await Bun.sleep(20);
    });
  }
}
/** Opens the welcome note, ready to type at its end. */
async function write(app: Parameters<typeof path>[0], ui: TestUI) {
  await act(async () => until(() => ui.captureCharFrame().includes("Welcome to Notes")));
  await click(ui, "Welcome to Notes");
  await act(async () => until(() => path(app) === "/notes/1"));
  await writeAtEnd(ui);
}
/** Ctrl+E: the cursor at the end of the text shown, as a click there would put it. */
const writeAtEnd = (ui: TestUI) =>
  act(async () => {
    ui.mockInput.pressKey("e", { ctrl: true });
  });
/** A left click in the middle of the renderable `id` (a button with no words: ≡, +, ⋯). */
const press = (ui: TestUI, id: string) =>
  act(async () => {
    const node = renderable(ui, id, Renderable);
    await ui.mockMouse.click(
      node.x + Math.floor(node.width / 2),
      node.y + Math.floor(node.height / 2),
    );
    await Bun.sleep(30);
  });
/** The sidebar at 110 columns: 30% of the screen. */
const SIDEBAR_WIDTH = 33;
const sidebarSlot = (ui: TestUI) => ui.renderer.root.findDescendantById("sidebar")?.parent;

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
    await writeAtEnd(ui);
    const input = (id: string) => markdownEditor(ui, id);
    const field = input("note-1");
    const seed = field.value;
    expect(seed).toContain("## Getting around");
    await act(async () => {
      await ui.mockInput.typeText("abc");
    });
    // Without autosave, unsaved text is marked, with its way to save.
    await eventually(() => status(ui) === "● Unsaved");
    expect(await frame(ui)).toContain("Save");
    const counts = () => metricsOf(server);
    const before = await counts();
    await act(async () => {
      ui.mockInput.pressKey("s", { ctrl: true });
    });
    await act(async () => {
      await ui.mockInput.typeText("d");
    });
    expect(field.value).toBe(`${seed}abcd`);
    const draft = draftOf(app, "1");
    expect(draft.pending?.value).toBe(`${seed}abc`);
    // Saving says nothing while it is quick.
    await frame(ui);
    expect(status(ui)).toBe("");
    await act(async () => {
      await until(() => !draft.pending);
      await Bun.sleep(50);
    });
    expect(draft.baseline).toBe(`${seed}abc`);
    expect(draft.value).toBe(`${seed}abcd`);
    expect(draft.dirty).toBe(true);
    expect(draft.version).toBe(2);
    expect(input("note-1").node).toBe(field.node);
    await eventually(() => status(ui) === "● Unsaved");
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
    expect(input("note-2").value).toContain("Coffee beans");
    // Unsaved work is marked in the list, whatever note is shown.
    expect(await frame(ui)).toContain("●");
    await click(ui, "Welcome to Notes");
    await act(async () => until(() => path(app) === "/notes/1"));
    expect(input("note-1").value).toBe(`${seed}abcd`);

    const localBefore = await counts();
    await writeAtEnd(ui);
    await act(async () => {
      await ui.mockInput.typeText("e");
      ui.mockInput.pressArrow("left");
      ui.mockInput.pressArrow("right");
      const currentField = input("note-1");
      currentField.node.blur();
      currentField.node.focus();
      await ui.mockMouse.scroll(currentField.node.x, currentField.node.y, "down");
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
    expect(input("note-1").value).toBe(`${seed}abcdef`);
    // A lost connection is said once it lasts; it speaks before the page, and says what
    // becomes of the unsaved text.
    await eventually(() => status(ui) === "○ Disconnected. Your text is kept here.", 5000);
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
    // The list's bar runs from one edge of the list to the other; the page's "+ New note"
    // is a block, a row of air above and below its words.
    const sidebar = renderable(ui, "sidebar", Renderable);
    const bar = renderable(ui, "sidebar-bar", Renderable);
    expect([bar.x, bar.width]).toEqual([sidebar.x, sidebar.width]);
    expect(renderable(ui, "start-note", Renderable).height).toBe(3);
    // No shortcut is ever written on screen.
    expect(await frame(ui)).not.toMatch(/ctrl\+|Ctrl\+|Esc /);

    // A new note opens with its title ready to type; Return moves on to the text.
    await press(ui, "new-note");
    await act(async () => until(() => /^\/notes\/[0-9a-f]{8}$/.test(path(app) ?? "")));
    const id = path(app)?.split("/").at(-1) ?? "";
    await act(async () => {
      await ui.mockInput.typeText("Plans");
      ui.mockInput.pressEnter();
    });
    await act(async () => {
      await ui.mockInput.typeText("- **one**");
    });
    // Autosave is off here: the line above the title offers to save.
    await act(async () => until(() => status(ui) === "● Unsaved"));
    await click(ui, "Save");
    await act(async () => until(() => !draftOf(app, id).dirty && !draftOf(app, id).pending));
    const shown = await frame(ui);
    // Saved, and nothing says so: no time, no "Saved".
    expect(status(ui)).toBe("");
    // Shown as it reads, and listed under its new title at the top.
    expect(shown).toContain("• one");
    expect(draftOf(app, id).value).toBe("- **one**");
    expect(shown).not.toContain("**one**");
    expect(shown.indexOf("Plans")).toBeLessThan(shown.indexOf("Welcome to Notes"));

    // Search narrows the list; the ✕ in the box clears it.
    await click(ui, "Search");
    await act(async () => {
      await ui.mockInput.typeText("coffee");
    });
    expect(await frame(ui)).toMatch(/\b1 of \d+ notes/);
    expect(await frame(ui)).not.toContain("Welcome to Notes");
    await click(ui, "✕");
    expect(await frame(ui)).toContain("Welcome to Notes");

    // The list slides away to a rail and comes back; ≡ stays where it was all along.
    const toggle = renderable(ui, "toggle-sidebar", Renderable);
    const at = [toggle.x, toggle.y];
    await press(ui, "toggle-sidebar");
    await untilRendered(ui, () => !ui.renderer.root.findDescendantById("sidebar"));
    expect(ui.renderer.root.findDescendantById("rail")).toBeDefined();
    expect([toggle.x, toggle.y]).toEqual(at);
    await press(ui, "toggle-sidebar");
    expect(ui.renderer.root.findDescendantById("sidebar")).toBeDefined();
    await untilRendered(ui, () => sidebarSlot(ui)?.width === SIDEBAR_WIDTH);
    expect([toggle.x, toggle.y]).toEqual(at);

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
    expect(Reflect.get(markdownEditor(ui, "note-2").node, "focused")).toBe(true);
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
    // However many notes the notebook is seeded with: one less, then as many again.
    const count = Number(/(\d+) notes/.exec(await frame(ui))?.[1]);
    // The note's own ⋯, at the end of its title: the same menu as its row's.
    await press(ui, "note-menu");
    expect(await frame(ui)).toContain("Copy as Markdown");
    await click(ui, "Delete");
    await act(async () => until(() => ui.captureCharFrame().includes("Deleted “Plans”")));
    expect(path(app)).not.toBe(`/notes/${id}`);
    expect(await frame(ui)).toContain(`${count - 1} notes`);
    await click(ui, "Undo");
    await act(async () => until(() => path(app) === `/notes/${id}`));
    await act(async () => until(() => ui.captureCharFrame().includes(`${count} notes`)));
  } finally {
    await stop();
  }
});

test("a save that cannot reach the Server is retried quietly, then reported until it saves", async () => {
  let refuse = true;
  const { app, ui, stop } = await start(
    "notes-refused",
    {},
    {
      network: {
        fault: ({ kind, target }) =>
          refuse && kind === "action" && target.endsWith("#saveNote") ? "refuse" : undefined,
      },
    },
  );
  try {
    await write(app, ui);
    await act(async () => {
      await ui.mockInput.typeText("kept");
    });
    const draft = draftOf(app, "1");
    const text = draft.value;
    const body = () => ui.renderer.root.findDescendantById("note-body")?.y;
    const top = body();
    const asked = performance.now();
    await act(async () => {
      ui.mockInput.pressKey("s", { ctrl: true });
    });
    // Refused at once, retried behind the user's back: nothing alarming yet, not even the
    // connection the refusal reported lost.
    await act(async () => until(() => draft.failures >= 2));
    expect(app.status).toBe("Disconnected");
    expect(status(ui)).not.toContain("Disconnected");
    await eventually(() => status(ui).includes("Disconnected"), QUIET_MS * 2);
    expect(performance.now() - asked).toBeGreaterThanOrEqual(QUIET_MS - 100);
    // The connection speaks for the save it failed, with the way to try it again.
    expect(status(ui)).toBe("○ Disconnected. Your text is kept here.");
    expect(await frame(ui)).toContain("Reconnect");
    // Nothing lost, nothing moved.
    expect(draft.value).toBe(text);
    expect(body()).toBe(top);
    // Back: Ctrl+S retries now, and the message leaves by itself.
    refuse = false;
    await act(async () => {
      ui.mockInput.pressKey("s", { ctrl: true });
    });
    await act(async () => until(() => !draft.pending && !draft.dirty));
    await frame(ui);
    expect(status(ui)).toBe("");
    expect(draft.baseline).toBe(text);
  } finally {
    await stop();
  }
});

test("a slow save is said to be slow, then unconfirmed, and settles once the Server has it", async () => {
  // The Server takes 4 s to save; the Client waits 3.5 s for an answer.
  const { app, ui, stop } = await start(
    "notes-timeout",
    { NOTES_DELAY_MS: "4000" },
    { timeoutMs: 3500 },
  );
  try {
    await write(app, ui);
    await act(async () => {
      await ui.mockInput.typeText("slow");
    });
    const draft = draftOf(app, "1");
    const text = draft.value;
    await act(async () => {
      ui.mockInput.pressKey("s", { ctrl: true });
    });
    await eventually(() => status(ui) === "Still saving…", QUIET_MS * 2);
    // Unanswered, the request reported the connection lost: that speaks first.
    await act(async () => until(() => draft.unknown, QUIET_MS));
    await eventually(() => status(ui) === "○ Disconnected. Your text is kept here.", QUIET_MS);
    expect(await frame(ui)).toContain("Reconnect");
    // Ctrl+S looks it up now, without waiting for the next automatic check.
    if (!draft.resolving)
      await act(async () => {
        ui.mockInput.pressKey("s", { ctrl: true });
      });
    expect(draft.resolving || !draft.pending).toBe(true);
    // The original save lands; the automatic check finds it.
    await act(async () => until(() => !draft.pending && !draft.dirty, QUIET_MS * 2));
    await frame(ui);
    expect(status(ui)).toBe("");
    expect(draft.baseline).toBe(text);
  } finally {
    await stop();
  }
});

test("a save of a note deleted elsewhere is refused and recorded, never retried forever", async () => {
  const { app, server, stop } = await start("notes-deleted");
  try {
    const call = (name: string, args: unknown[]) =>
      app.callServer(`${server.buildId}/actions/notes.ts#${name}`, args);
    await call("deleteNote", ["2"]);
    const operationId = crypto.randomUUID();
    const refused = { ok: false, error: "This note was deleted", operationId };
    expect(
      await call("saveNote", [{ id: "2", value: "late", version: 1, revision: 0, operationId }]),
    ).toEqual(refused);
    // A lookup finds the refusal: an unknown outcome settles instead of being sent again.
    expect(await call("getOperation", [operationId])).toEqual(refused);
  } finally {
    await stop();
  }
});
