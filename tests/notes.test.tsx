/** @jsxImportSource @opentui/react */
import { test, expect } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { InputRenderable } from "@opentui/core";
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
  type TestUI,
} from "./helpers";
const appDir = resolve("examples/notes");
test("generated Notes: Flight action, preserved Draft, navigation, validation and offline editing", async () => {
  await build(appDir);
  const folder = await mkdtemp(join(tmpdir(), "luciole-notes-"));
  const server = await launch(join(appDir, ".luciole/server/index.js"), {
    NOTES_DB: join(folder, "notes.sqlite"),
    NOTES_DELAY_MS: "400",
  });
  const { createApp, Shell } = await importClient(appDir, "notes");
  const app = createApp({ url: server.url });
  let rendered: TestUI | undefined;
  try {
    expect(server.pid).not.toBe(process.pid);
    await app.router.load();
    const ui = await testRender(<Shell app={app} />, { width: 100, height: 24 });
    rendered = ui;
    await act(async () => {
      ui.mockInput.pressEnter();
      await until(() => app.router.state.resolvedLocation?.pathname === "/notes/1");
    });
    const input = (id: string) => renderable(ui, id, InputRenderable);
    const field = input("note-1");
    await act(async () => {
      await ui.mockInput.typeText("abc");
    });
    const counts = () => metricsOf(server);
    const before = await counts();
    await act(async () => {
      ui.mockInput.pressEnter();
    });
    await act(async () => {
      await ui.mockInput.typeText("d");
    });
    expect(field.value).toBe("abcd");
    const draft = draftOf(app, "1");
    expect(draft.pending?.value).toBe("abc");
    await act(async () => {
      await until(() => !draft.pending);
      await Bun.sleep(50);
    });
    expect(draft.baseline).toBe("abc");
    expect(draft.value).toBe("abcd");
    expect(draft.dirty).toBe(true);
    expect(input("note-1")).toBe(field);
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("version 2");
    expect((await counts()).actions - before.actions).toBe(1);
    await act(async () => {
      await app.router.navigate({ to: "/" });
    });
    await act(async () => {
      await app.router.navigate({ to: "/notes/2" });
    });
    expect(input("note-2").value).toBe("");
    await act(async () => {
      await app.router.navigate({ to: "/notes/1" });
    });
    expect(input("note-1").value).toBe("abcd");
    // The nested notes layout persisted from note 2 to note 1.
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("Opened this visit: 2 → 1");
    const localBefore = await counts();
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
    expect(input("note-1").value).toBe("abcdef");
  } finally {
    await destroy(rendered);
    await server.stop();
    await rm(folder, { recursive: true, force: true });
  }
});
