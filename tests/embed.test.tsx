/** @jsxImportSource @opentui/react */
import { test, expect } from "bun:test";
import { act, useState, useSyncExternalStore, type ReactNode } from "react";
import { InputRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider, useBindings } from "@opentui/keymap/react";
import { createRootRoute } from "@tanstack/react-router";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../packages/luciole/src/build";
import {
  Application,
  Embed,
  openApplication,
  type ApplicationEvent,
  type ApplicationOptions,
} from "../packages/luciole/src/client";
import { ApplicationView } from "../packages/luciole/src/embed";
import { destroy, launch, rejectionOf, until, type TestUI } from "./helpers";

const mdreader = resolve("examples/mdreader");
const files = resolve("examples/files");
const bundleOf = (app: string) => join(app, ".luciole/app");

/** The host's keymap, as a Shell provides it, and its prefix sequence. */
function Host({ children, onSwitch }: { children: ReactNode; onSwitch: () => void }) {
  const renderer = useRenderer();
  const [keymap] = useState(() => createDefaultOpenTuiKeymap(renderer));
  return (
    <KeymapProvider keymap={keymap}>
      <Switch onSwitch={onSwitch} />
      {children}
    </KeymapProvider>
  );
}
function Switch({ onSwitch }: { onSwitch: () => void }) {
  useBindings(() => ({ bindings: [{ key: "ctrl+oo", cmd: onSwitch }] }), [onSwitch]);
  return null;
}
/** A pane whose view throws: what a crash inside an embedded application looks like. */
class Crashing extends Application {
  override readonly view = (): ReactNode => {
    throw new Error("pane exploded");
  };
}
const options = (): ApplicationOptions => ({
  url: "http://127.0.0.1:1",
  buildId: "crash",
  resolveModule: () => ({}),
  routeTree: createRootRoute(),
});

test("<Embed>: two applications, keys to the active pane, focus set aside, crash contained, dispose", async () => {
  await build(mdreader);
  await build(files);
  const docs = await mkdtemp(join(tmpdir(), "luciole-embed-"));
  await Bun.write(join(docs, "README.md"), "# Readme\n\nThe first document.\n");
  await Bun.write(join(docs, "guide.md"), "# Guide\n\nThe second document.\n");
  const md = await launch(join(mdreader, ".luciole/server/index.js"), { MD_PATH: docs });
  const fx = await launch(join(files, ".luciole/server/index.js"), { FILES_ROOT: docs });
  let ui: TestUI | undefined;
  const apps: Application[] = [];
  try {
    const mdApp = await openApplication({ bundle: bundleOf(mdreader), url: md.url });
    const fxApp = await openApplication({ bundle: bundleOf(files), url: fx.url });
    apps.push(mdApp, fxApp);
    expect(mdApp.options.instance).not.toBe(fxApp.options.instance);
    // One runtime for every pane: the host's view, hence the host's contexts.
    expect(mdApp.view).toBe(ApplicationView);
    expect(fxApp.view).toBe(ApplicationView);
    const events = new Map<Application, ApplicationEvent[]>([
      [mdApp, []],
      [fxApp, []],
    ]);
    for (const [app, list] of events) app.onEvent((e) => list.push(e));
    const count = (app: Application) => events.get(app)?.length ?? 0;
    // What `app` started since event `from`: a request, a page load, an invalidation. The
    // events that finish a call already under way (its response, chunks, end, the
    // navigation it resolves) can land later on a loaded machine and say nothing of keys.
    const startedSince = (app: Application, from: number) =>
      (events.get(app) ?? [])
        .slice(from)
        .filter(
          (e) =>
            e.type === "request" ||
            e.type === "invalidate" ||
            (e.type === "loader" && e.phase === "start"),
        );
    // Which pane has the keys: the host's state, switched by its prefix sequence.
    let active: "md" | "fx" = "md";
    const activePane = (): "md" | "fx" => active;
    const listeners = new Set<() => void>();
    const toggle = () => {
      active = active === "md" ? "fx" : "md";
      for (const l of listeners) l();
    };
    const crashing = new Crashing(options());
    function Panes() {
      const current = useSyncExternalStore(
        (l) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
        () => active,
      );
      return (
        <box flexDirection="row" flexGrow={1}>
          <Embed app={mdApp} name="md" active={current === "md"} prefix="ctrl+o" flexGrow={1} />
          <Embed app={fxApp} name="fx" active={current === "fx"} prefix="ctrl+o" flexGrow={1} />
          <Embed app={crashing} name="bomb" active={false} flexGrow={1} />
        </box>
      );
    }
    ui = await testRender(
      <Host onSwitch={toggle}>
        <Panes />
      </Host>,
      { width: 200, height: 24 },
    );
    const frame = () => {
      void ui?.renderOnce();
      return ui?.captureCharFrame() ?? "";
    };
    await act(async () => {
      await until(
        () => frame().includes("The first document.") && frame().includes("guide.md"),
        15_000,
      );
    });
    // A crash stays in its pane.
    expect(frame()).toContain("bomb crashed:");
    expect(frame()).toContain("pane exploded");

    // `[` belongs to mdreader: with mdreader active it opens the previous document…
    const fxBefore = count(fxApp);
    await act(async () => {
      ui?.mockInput.pressKey("[");
      await until(() => frame().includes("The second document."), 10_000);
    });
    // …and files, which is not active, heard nothing.
    expect(startedSince(fxApp, fxBefore)).toEqual([]);

    // mdreader's find field takes the focus.
    await act(async () => ui?.mockInput.pressKey("/"));
    await act(async () => ui?.mockInput.typeText("gu"));
    const field = ui.renderer.currentFocusedRenderable;
    expect(field).toBeInstanceOf(InputRenderable);
    const typed = field instanceof InputRenderable ? field : undefined;
    expect(typed?.value).toBe("gu");

    // The host's prefix switches panes even though mdreader has a focused input: the
    // input is set aside, and typing no longer reaches it.
    await act(async () => {
      ui?.mockInput.pressKey("o", { ctrl: true });
      ui?.mockInput.pressKey("o");
    });
    expect(activePane()).toBe("fx");
    expect(ui.renderer.currentFocusedRenderable).toBeNull();
    const mdBefore = count(mdApp);
    await act(async () => {
      await ui?.mockInput.typeText("zz");
      await Bun.sleep(300);
    });
    expect(typed?.value).toBe("gu");
    expect(startedSince(mdApp, mdBefore)).toEqual([]);

    // Back to mdreader: its input has the focus again, and the typing.
    await act(async () => {
      ui?.mockInput.pressKey("o", { ctrl: true });
      ui?.mockInput.pressKey("o");
    });
    expect(ui.renderer.currentFocusedRenderable).toBe(typed ?? null);
    await act(async () => ui?.mockInput.typeText("i"));
    expect(typed?.value).toBe("gui");

    // Disposing a pane stops its requests and unregisters its modules.
    const instance = mdApp.options.instance ?? "";
    mdApp.dispose();
    expect(mdApp.disposed).toBe(true);
    expect(() => globalThis.__webpack_require__(`${instance}@x/y.tsx`)).toThrow(
      "Unknown Client module",
    );
    expect(await rejectionOf(mdApp.callServer("x#y", []))).toBeDefined();
  } finally {
    await destroy(ui);
    for (const app of apps) app.dispose();
    await md.stop();
    await fx.stop();
    await rm(docs, { recursive: true, force: true });
  }
}, 90_000);
