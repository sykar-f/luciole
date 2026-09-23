/** @jsxImportSource @opentui/react */
import { test, expect } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../src/build";
import { launch, until, draftsOf } from "./helpers";
const appDir = resolve("examples/notes");
test("generated Notes: Flight action, preserved Draft, navigation, validation and offline editing", async () => {
  await build(appDir);
  const folder = await mkdtemp(join(tmpdir(), "airtty-notes-"));
  const server = await launch(join(appDir, ".airtty/server/index.js"), {
    NOTES_DB: join(folder, "notes.sqlite"),
    NOTES_DELAY_MS: "400",
  });
  const { createApp, Shell } = await import(join(appDir, ".airtty/client/index.js") + "?notes");
  const app = createApp({ url: server.url });
  let ui: any;
  try {
    expect(server.pid).not.toBe(process.pid);
    await app.router.load();
    ui = await testRender(<Shell app={app} />, { width: 100, height: 24 });
    await act(async () => {
      await ui.mockInput.pressEnter();
      await until(() => app.router.state.resolvedLocation?.pathname === "/notes/1");
    });
    const field = ui.renderer.root.findDescendantById("note-1");
    expect(field).toBeDefined();
    await act(async () => {
      await ui.mockInput.typeText("abc");
    });
    const counts = async () =>
      await (
        await fetch(server.url + "/test-metrics", {
          headers: { "x-airtty-build": server.buildId },
        })
      ).json();
    const before = await counts();
    await act(async () => {
      await ui.mockInput.pressEnter();
    });
    await act(async () => {
      await ui.mockInput.typeText("d");
    });
    expect(field.value).toBe("abcd");
    const draft = draftsOf(app).get({ id: "1" });
    expect(draft.pending.value).toBe("abc");
    await act(async () => {
      await until(() => !draft.pending);
      await Bun.sleep(50);
    });
    expect(draft.baseline).toBe("abc");
    expect(draft.value).toBe("abcd");
    expect(draft.dirty).toBe(true);
    expect(ui.renderer.root.findDescendantById("note-1")).toBe(field);
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("version 2");
    expect((await counts()).actions - before.actions).toBe(1);
    await act(async () => {
      await app.router.navigate({ to: "/" });
    });
    await act(async () => {
      await app.router.navigate({ to: "/notes/2" });
    });
    expect(ui.renderer.root.findDescendantById("note-2").value).toBe("");
    await act(async () => {
      await app.router.navigate({ to: "/notes/1" });
    });
    expect(ui.renderer.root.findDescendantById("note-1").value).toBe("abcd");
    // The nested notes layout persisted from note 2 to note 1.
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("Opened this visit: 2 → 1");
    const localBefore = await counts();
    await act(async () => {
      await ui.mockInput.typeText("e");
      await ui.mockInput.pressArrow("left");
      await ui.mockInput.pressArrow("right");
      const currentField = ui.renderer.root.findDescendantById("note-1");
      currentField.blur();
      currentField.focus();
      await ui.mockMouse.scroll(currentField.x, currentField.y, "down");
    });
    expect(await counts()).toEqual(localBefore);
    await server.stop();
    await act(async () => {
      await app.refresh();
      await ui.mockInput.typeText("f");
    });
    expect(app.status).toBe("Disconnected");
    expect(ui.renderer.root.findDescendantById("note-1").value).toBe("abcdef");
  } finally {
    if (ui) await act(async () => ui.renderer.destroy());
    await server.stop();
    await rm(folder, { recursive: true, force: true });
  }
});
