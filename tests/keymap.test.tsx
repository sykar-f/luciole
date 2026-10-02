/** @jsxImportSource @opentui/react */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { Renderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { build } from "../packages/core/src/build";
import { launch, importClient, destroy, renderable, temporaryApp, type TestUI } from "./helpers";

// An application that shows its keys, as a terminal program does: a footer for the
// layout's layer, a line for the page's. Inside the checkout so `luciole` resolves.
const FILES: Record<string, string> = {
  "tsconfig.json": JSON.stringify({
    extends: "../packages/core/tsconfig.base.json",
    include: ["app", "components"],
  }),
  "app/layout.tsx": `"use client";
import { KeyHelp, useBindings, useConnection, type LayoutProps } from "@luciole-sh/core/client";
export default function Layout({ children }: LayoutProps) {
  const { refresh } = useConnection();
  useBindings(() => ({ bindings: [
    { key: "ctrl+r", cmd: () => void refresh(), desc: "reconnect", group: "global" },
    { key: "ctrl+t", cmd: () => {}, desc: "requests", group: "global" },
  ] }), [refresh]);
  return (
    <box flexDirection="column" flexGrow={1}>
      {children}
      <box id="footer" height={1}><KeyHelp inline groups={["global", "luciole"]} /></box>
    </box>
  );
}`,
  "app/page.tsx": "export default function Page(){return <text>home</text>}",
  "app/items/[id]/page.tsx": `import { Editor } from "../../../components/Editor";
export default function Page(){return <Editor />}`,
  "components/Editor.tsx": `"use client";
import { KeyHelp, useBindings, useNavigate } from "@luciole-sh/core/client";
export function Editor() {
  const navigate = useNavigate();
  useBindings(() => ({ bindings: [
    { key: "ctrl+s", cmd: () => {}, desc: "save", group: "item" },
    { key: "escape", cmd: () => void navigate({ to: "/" }), desc: "list", group: "item" },
  ] }), [navigate]);
  return <box id="item-help" height={1}><KeyHelp inline groups={["item"]} /></box>;
}`,
};
let root = "";
beforeAll(async () => {
  root = await temporaryApp("keymap");
  for (const [name, text] of Object.entries(FILES)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await Bun.write(join(root, name), text);
  }
  await build(root);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("help is generated from the keymap layers mounted right now", async () => {
  const server = await launch(join(root, ".luciole/server/index.js"));
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
    expect(await text("footer")).toBe("ctrl+c quit · ctrl+r reconnect · ctrl+t requests");
    await act(async () => {
      await app.router.navigate({ to: "/items/$id", params: { id: "1" } });
    });
    expect(await text("item-help")).toBe("ctrl+s save · escape list");
    // The editor's bindings run through the keymap.
    await act(async () => {
      ui.mockInput.pressEscape();
      await Bun.sleep(50);
    });
    expect(app.router.state.resolvedLocation?.pathname).toBe("/");
    // Its layer left with it: Ctrl+S is no longer bound anywhere.
    expect(await text("footer")).toBe("ctrl+c quit · ctrl+r reconnect · ctrl+t requests");
    expect(ui.captureCharFrame()).not.toContain("ctrl+s");
  } finally {
    await destroy(rendered);
    await server.stop();
  }
});

test("a desktop window leaves Ctrl+C to the application", async () => {
  const server = await launch(join(root, ".luciole/server/index.js"));
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
    const { x, y, width } = renderable(ui, "footer", Renderable);
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
  }
});
