/** @jsxImportSource @opentui/react */
import { test, expect } from "bun:test";
import { act, useSyncExternalStore } from "react";
import { testRender } from "@opentui/react/test-utils";
import { createRootRoute } from "@tanstack/react-router";
import {
  createApplication,
  useCapability,
  useGlobalKey,
  useHostMessage,
  type Application,
  type CapabilityState,
  type HostChannel,
  type HostEvent,
  type MediatedCapability,
} from "../packages/airtty/src/client";
import { Runtime } from "../packages/airtty/src/runtime-context";
import { destroy, type TestUI } from "./helpers";

/** A host whose events and capability states the test drives. */
function drivenHost() {
  const listeners = new Set<(event: HostEvent) => void>();
  const states = new Map<MediatedCapability, CapabilityState>();
  const channel: HostChannel = {
    request: () => Promise.resolve(undefined),
    state: (capability) => states.get(capability) ?? "prompt",
    listen: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const emit = (event: HostEvent) => {
    if (event.type === "capability") states.set(event.capability, event.state);
    for (const listener of listeners) listener(event);
  };
  return { channel, listeners, emit };
}
const applicationWith = (host?: HostChannel) =>
  createApplication({
    url: "http://127.0.0.1:1",
    buildId: "test",
    routeTree: createRootRoute(),
    resolveModule: () => ({}),
    host,
  });

async function mount(app: Application, children: React.ReactNode) {
  let ui: TestUI | undefined;
  await act(async () => {
    ui = await testRender(<Runtime.Provider value={app}>{children}</Runtime.Provider>, {
      width: 40,
      height: 4,
    });
  });
  const frame = async () => {
    await act(async () => {
      await ui?.renderOnce();
    });
    return ui?.captureCharFrame() ?? "";
  };
  return { ui, frame };
}

test("useHostMessage and useGlobalKey listen while mounted, and stop at unmount", async () => {
  const { channel, listeners, emit } = drivenHost();
  const app = applicationWith(channel);
  const messages: unknown[] = [];
  const keys: string[] = [];
  // Whether the listener is mounted, as external state the test switches.
  let shown = true;
  const watchers = new Set<() => void>();
  const hide = () => {
    shown = false;
    for (const watcher of watchers) watcher();
  };
  function Listener() {
    useHostMessage((message, from) => messages.push([from, message]));
    useGlobalKey("ctrl+s", (key) => keys.push(key.name));
    return <text>listening</text>;
  }
  function Toggle() {
    const visible = useSyncExternalStore(
      (watcher) => {
        watchers.add(watcher);
        return () => watchers.delete(watcher);
      },
      () => shown,
    );
    return visible ? <Listener /> : <text>gone</text>;
  }
  const { ui, frame } = await mount(app, <Toggle />);
  try {
    expect(await frame()).toContain("listening");
    expect(listeners.size).toBe(2);
    const key = (name: string, ctrl: boolean) =>
      emit({ type: "input.key", key: { name, sequence: "", ctrl, meta: false, shift: false } });
    emit({ type: "tabs.message", from: "http://other", message: { hello: 1 } });
    key("s", true);
    key("s", false);
    key("x", true);
    expect(messages).toEqual([["http://other", { hello: 1 }]]);
    expect(keys).toEqual(["s"]);
    await act(async () => hide());
    expect(await frame()).toContain("gone");
    // Unmounted: unsubscribed, nothing more arrives.
    expect(listeners.size).toBe(0);
    emit({ type: "tabs.message", from: "http://other", message: 2 });
    expect(messages).toHaveLength(1);
  } finally {
    await destroy(ui);
    app.dispose();
  }
});

test("useCapability re-renders when the user grants or refuses", async () => {
  const { channel, emit } = drivenHost();
  const app = applicationWith(channel);
  function State() {
    return <text>clipboard {useCapability("clipboard.write")}</text>;
  }
  const { ui, frame } = await mount(app, <State />);
  try {
    expect(await frame()).toContain("clipboard prompt");
    await act(async () =>
      emit({ type: "capability", capability: "clipboard.write", state: "granted" }),
    );
    expect(await frame()).toContain("clipboard granted");
    // Another capability's change does not concern it.
    await act(async () => emit({ type: "capability", capability: "notify", state: "denied" }));
    expect(await frame()).toContain("clipboard granted");
    await act(async () =>
      emit({ type: "capability", capability: "clipboard.write", state: "denied" }),
    );
    expect(await frame()).toContain("clipboard denied");
  } finally {
    await destroy(ui);
    app.dispose();
  }
});

test("outside the sandbox every capability is granted", async () => {
  const app = applicationWith();
  function State() {
    return <text>notify {useCapability("notify")}</text>;
  }
  const { ui, frame } = await mount(app, <State />);
  try {
    expect(await frame()).toContain("notify granted");
  } finally {
    await destroy(ui);
    app.dispose();
  }
});
