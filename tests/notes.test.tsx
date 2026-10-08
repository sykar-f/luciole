/** @jsxImportSource @opentui/react */
import { test, expect } from "bun:test";
import { act } from "react";
import { Renderable, TextRenderable } from "@opentui/core";
import { MouseButtons, type MouseButton } from "@opentui/core/testing";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TransportError, type Transport } from "../packages/core/src/client";
import { openClient, startServer } from "../packages/core/src/test";
import {
  BUILD_TEST_MS,
  privateBuild,
  WAIT_MS,
  until as pollUntil,
  draftOf,
  metricsOf,
  markdownEditor,
  clickOn,
  renderable,
  type ClientOptions,
  type TestUI,
} from "./helpers";
const built = await privateBuild("examples/notes");

async function start(
  tag: string,
  env: Record<string, string> = {},
  options: Omit<ClientOptions, "url"> = {},
) {
  const folder = await mkdtemp(join(tmpdir(), "luciole-notes-"));
  const server = await startServer(built, {
    NOTES_DB: join(folder, "notes.sqlite"),
    // Saves only when asked: the requests counted below are the test's own.
    NOTES_AUTOSAVE_MS: "0",
    ...env,
  });
  const client = await openClient(built, server, { tag, width: 110, height: 32, ...options });
  return {
    app: client.app,
    ui: client.ui,
    server,
    requests: client.requests,
    stop: async () => {
      await client.stop();
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
  const deadline = performance.now() + WAIT_MS;
  while (!check() && performance.now() < deadline)
    await act(async () => {
      await ui.renderOnce();
      // The step of a poll bounded by WAIT_MS, not a wait for the outcome.
      await Bun.sleep(10);
    });
  expect(check()).toBe(true);
};
/** Renders frames until one shows `text`. */
const untilShown = (ui: TestUI, text: string | RegExp) =>
  untilRendered(ui, () =>
    typeof text === "string"
      ? ui.captureCharFrame().includes(text)
      : text.test(ui.captureCharFrame()),
  );
/** What the line above the title says; nothing while saves go well. */
const status = (ui: TestUI) => {
  const node = ui.renderer.root.findDescendantById("note-status");
  return node instanceof TextRenderable ? node.plainText : "";
};
/** How long a save stays unmentioned (NoteEditor's QUIET_MS). */
const QUIET_MS = 3000;
const until = (check: () => boolean, timeout = WAIT_MS) => pollUntil(check, timeout);
/**
 * Waits for `check`, one short `act()` at a time: timers' state updates apply when an
 * `act()` ends, not within one.
 */
async function eventually(check: () => boolean, timeout = WAIT_MS) {
  const deadline = performance.now() + timeout;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("Condition timed out");
    await act(async () => {
      // The step of a poll bounded by `timeout`: timers fire between two `act()`s.
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
  });
/** The sidebar at 110 columns: 30% of the screen. */
const SIDEBAR_WIDTH = 33;
const sidebarSlot = (ui: TestUI) => ui.renderer.root.findDescendantById("sidebar")?.parent;

/** Clicks inside `act()`; the caller waits for what the click does. */
const click = (ui: TestUI, text: string, button?: MouseButton) =>
  act(async () => {
    await clickOn(ui, text, button);
  });

test(
  "generated Notes: Flight action, preserved Draft, navigation and offline editing",
  async () => {
    const { app, ui, server, requests, stop } = await start("notes", {
      NOTES_DELAY_MS: "400",
    });
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
      const finished = requests.finished.length;
      // The save, then the list read again because the save invalidated it.
      const saveAndRead = () =>
        requests.finished.slice(finished).filter((event) => event.kind === "action").length >= 2;
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
        await until(saveAndRead);
      });
      // The list read has landed and rendered: had it remounted the editor, it is done.
      await frame(ui);
      expect(draft.baseline).toBe(`${seed}abc`);
      expect(draft.value).toBe(`${seed}abcd`);
      expect(draft.dirty).toBe(true);
      expect(draft.version).toBe(2);
      expect(input("note-1").node).toBe(field.node);
      await eventually(() => status(ui) === "● Unsaved");
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
      await eventually(() => status(ui) === "○ Disconnected. Your text is kept here.");
      expect(await frame(ui)).toContain("Reconnect");
    } finally {
      await stop();
    }
  },
  BUILD_TEST_MS,
);

test(
  "every action is a click: new, rename, search, fold, delete and undo",
  async () => {
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
      const searchField = () => renderable(ui, "search-field", Renderable);
      await act(async () => until(() => Reflect.get(searchField(), "focused") === true));
      await act(async () => {
        await ui.mockInput.typeText("coffee");
      });
      await untilShown(ui, /\b1 of \d+ notes/);
      expect(await frame(ui)).not.toContain("Welcome to Notes");
      await click(ui, "✕");
      await untilShown(ui, "Welcome to Notes");

      // The list slides away to a rail and comes back; ≡ stays where it was all along.
      const toggle = renderable(ui, "toggle-sidebar", Renderable);
      const at = [toggle.x, toggle.y];
      await press(ui, "toggle-sidebar");
      await untilRendered(ui, () => !ui.renderer.root.findDescendantById("sidebar"));
      expect(ui.renderer.root.findDescendantById("rail")).toBeDefined();
      expect([toggle.x, toggle.y]).toEqual(at);
      await press(ui, "toggle-sidebar");
      await untilRendered(ui, () => !!ui.renderer.root.findDescendantById("sidebar"));
      await untilRendered(ui, () => sidebarSlot(ui)?.width === SIDEBAR_WIDTH);
      expect([toggle.x, toggle.y]).toEqual(at);

      // A right click on a note offers its menu; Rename… opens its title.
      await click(ui, "Shopping list", MouseButtons.RIGHT);
      await untilShown(ui, "Rename…");
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
          {
            id: "2",
            value: "theirs",
            version: 1,
            revision: 0,
            operationId: crypto.randomUUID(),
          },
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
      await untilShown(ui, "Copy as Markdown");
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
  },
  BUILD_TEST_MS,
);

test(
  "a save that cannot reach the Server is retried quietly, then reported until it saves",
  async () => {
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
      await eventually(() => status(ui).includes("Disconnected"));
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
  },
  BUILD_TEST_MS,
);

/**
 * A Server slow to save, by the test's hand rather than the clock's: the requests that
 * save a note or look a save up reach the Server only once `land()` is called, and the
 * first save is given up on, as the transport does when its timeout passes, once
 * `timeOut()` is. The states between are held for as long as the test needs to look at
 * them, however loaded the host is.
 */
function slowSaves() {
  const landing = Promise.withResolvers<void>();
  const timedOut = Promise.withResolvers<void>();
  let firstSave = true;
  return {
    land: () => landing.resolve(),
    timeOut: () => timedOut.resolve(),
    wrapTransport: (inner: Transport): Transport => ({
      render: (...args) => inner.render(...args),
      setToken: (token) => inner.setToken(token),
      call(actionId, args, signal, context) {
        const saving = actionId.endsWith("#saveNote");
        if (!saving && !actionId.endsWith("#getOperation"))
          return inner.call(actionId, args, signal, context);
        const reached = landing.promise.then(() => inner.call(actionId, args, signal, context));
        if (!saving || !firstSave) return reached;
        firstSave = false;
        return Promise.race([
          reached,
          timedOut.promise.then(() => {
            throw new TransportError("The operation timed out.");
          }),
        ]);
      },
    }),
  };
}

test(
  "a slow save is said to be slow, then unconfirmed, and settles once the Server has it",
  async () => {
    const server = slowSaves();
    const { app, ui, stop } = await start("notes-timeout", {}, server);
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
      // Held, the save is said to be slow once QUIET_MS have passed, and stays said.
      await eventually(() => status(ui) === "Still saving…");
      // No answer in time: the request reports the connection lost, and that speaks first.
      server.timeOut();
      await act(async () => until(() => draft.unknown));
      await eventually(() => status(ui) === "○ Disconnected. Your text is kept here.");
      expect(await frame(ui)).toContain("Reconnect");
      // Ctrl+S looks it up now, without waiting for the next automatic check.
      if (!draft.resolving)
        await act(async () => {
          ui.mockInput.pressKey("s", { ctrl: true });
        });
      expect(draft.resolving || !draft.pending).toBe(true);
      // The original save lands; the check that waits for it finds it.
      server.land();
      await act(async () => until(() => !draft.pending && !draft.dirty));
      await frame(ui);
      expect(status(ui)).toBe("");
      expect(draft.baseline).toBe(text);
    } finally {
      await stop();
    }
  },
  BUILD_TEST_MS,
);

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
