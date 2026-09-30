/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { act } from "react";
import { Renderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../packages/luciole/src/build";
import { launch, importClient, destroy, renderable, type TestUI } from "./helpers";

const root = resolve("examples/notes");

test("help is generated from the keymap layers mounted right now", async () => {
  await build(root);
  const dir = await mkdtemp(join(tmpdir(), "luciole-keymap-"));
  const server = await launch(join(root, ".luciole/server/index.js"), {
    NOTES_DB: join(dir, "notes.sqlite"),
  });
  const { createApp, Shell } = await importClient(root, "keymap");
  const app = createApp({ url: server.url });
  let rendered: TestUI | undefined;
  try {
    await app.router.load();
    const ui = await testRender(<Shell app={app} />, { width: 100, height: 24 });
    rendered = ui;
    const text = async (id: string) => {
      await ui.renderOnce();
      const { x, y, width } = renderable(ui, id, Renderable);
      return ui
        .captureCharFrame()
        .split("\n")
        [y].slice(x, x + width)
        .trim();
    };
    // Application and framework layers, filtered by group.
    expect(await text("notes-footer")).toBe("ctrl+c quit · ctrl+r reconnect · ctrl+t requests");
    await act(async () => {
      await app.router.navigate({ to: "/notes/$id", params: { id: "1" } });
    });
    expect(await text("note-help")).toBe(
      "ctrl+s save · escape list · ctrl+o resolve · ctrl+d discard",
    );
    // The editor's bindings run through the keymap.
    await act(async () => {
      ui.mockInput.pressEscape();
      await Bun.sleep(50);
    });
    expect(app.router.state.resolvedLocation?.pathname).toBe("/");
    // Its layer left with it: Ctrl+S is no longer bound anywhere.
    expect(await text("notes-footer")).toBe("ctrl+c quit · ctrl+r reconnect · ctrl+t requests");
    expect(ui.captureCharFrame()).not.toContain("ctrl+s");
  } finally {
    await destroy(rendered);
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a desktop window leaves Ctrl+C to the application", async () => {
  await build(root);
  const dir = await mkdtemp(join(tmpdir(), "luciole-keymap-"));
  const server = await launch(join(root, ".luciole/server/index.js"), {
    NOTES_DB: join(dir, "notes.sqlite"),
  });
  const { createApp, Shell } = await importClient(root, "keymap-desktop");
  const app = createApp({ url: server.url, quitOnCtrlC: false });
  let quits = 0;
  app.quit = () => void quits++;
  let rendered: TestUI | undefined;
  try {
    await app.router.load();
    const ui = await testRender(<Shell app={app} />, { width: 100, height: 24 });
    rendered = ui;
    await ui.renderOnce();
    const { x, y, width } = renderable(ui, "notes-footer", Renderable);
    const footer = ui
      .captureCharFrame()
      .split("\n")
      [y].slice(x, x + width)
      .trim();
    expect(footer).toBe("ctrl+r reconnect · ctrl+t requests");
    await act(async () => {
      ui.mockInput.pressCtrlC();
      await Bun.sleep(50);
    });
    expect(quits).toBe(0);
  } finally {
    await destroy(rendered);
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
