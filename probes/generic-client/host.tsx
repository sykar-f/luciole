/** @jsxImportSource @opentui/react */
import { Component, useLayoutEffect, useState, type ReactNode } from "react";
import type { CliRenderer, KeyEvent, Renderable } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { Keymap, type KeymapHost } from "@opentui/keymap";
import {
  registerDefaultKeys,
  registerEnabledFields,
  registerMetadataFields,
} from "@opentui/keymap/addons";
import { createOpenTuiKeymapHost } from "@opentui/keymap/opentui";
import { KeymapProvider } from "@opentui/keymap/react";
import type { Application, ApplicationOptions } from "../../packages/luciole/src/client";
import { messageOf } from "../../packages/luciole/src/guards";
import type { AbiSpecifier } from "./abi";
import type { LoadedBundle } from "./loader";
import { abiModules, type Runtime } from "./runtime";

/** Every Client pane: one Application, one module instance, one key. */
type PaneOptions = Omit<ApplicationOptions, "routeTree" | "buildId" | "resolveModule">;
export const INSTANCE_HEADER = "x-luciole-instance";

/**
 * Several applications in one Client process, one Application per pane. Stands for the
 * refactor proposed in docs/EMBEDDING.md, done from outside src/:
 *
 * - `resolveModule`: one router for every pane, by the prefix of the id the Server wrote.
 *   React Flight's browser codec reads the single global `__webpack_require__`, lazily at
 *   render, so per-Application resolvers overwrite one another.
 * - `abiFor(key)`: a per-pane `luciole/client` whose `actionReference` calls that pane's
 *   Application, instead of the process-wide `current` of src/client.tsx.
 *
 * `routeBy: "instance"` (decided): each pane has its own key, sent as
 * `x-luciole-instance`, and the Server prefixes Client Reference ids with it
 * (`p2@<buildId>/<path>`, see probes/inline/instance-server.ts). Two panes of one build
 * keep their own modules. `routeBy: "build"` keys by the build ID the ids already carry,
 * with no Server change: kept to show why it is not enough.
 */
export function createPanes(runtime: Runtime, { routeBy }: { routeBy: "instance" | "build" }) {
  const panes = new Map<
    string,
    { modules?: LoadedBundle["modules"]; app?: Application; resolved: number }
  >();
  let opened = 0;
  const split = (id: string) => {
    const at = routeBy === "instance" ? id.indexOf("@") : id.indexOf("/");
    return routeBy === "instance"
      ? { key: id.slice(0, at), local: id.slice(at + 1) }
      : { key: id.slice(0, at), local: id };
  };
  const resolveModule = (id: string) => {
    const { key, local } = split(id);
    const pane = panes.get(key);
    const module = pane?.modules?.get(local);
    if (!pane || !module) throw new Error(`Unknown Client module: ${id}`);
    pane.resolved++;
    return module;
  };
  const appOf = (key: string) => {
    const app = panes.get(key)?.app;
    if (!app) throw new Error(`No Application mounted for ${key}`);
    return app;
  };
  const base = abiModules(runtime);
  return {
    resolveModule,
    /** A key for a new pane of `buildId`; with `build`, every pane of a build shares it. */
    open(buildId: string) {
      const key = routeBy === "instance" ? `p${++opened}` : buildId;
      panes.set(key, { resolved: 0 });
      return key;
    },
    /** The ABI the bundle of pane `key` is evaluated against. */
    abiFor(key: string) {
      const client = {
        ...runtime.lucioleClient,
        actionReference: (id: string) =>
          runtime.flight.createServerReference(id, (action: string, args: unknown[]) =>
            appOf(key).callServer(action, args),
          ),
      };
      return (specifier: AbiSpecifier) =>
        specifier === "luciole/client" ? client : base[specifier];
    },
    mount(key: string, bundle: LoadedBundle, options: PaneOptions) {
      const pane = panes.get(key);
      if (!pane) throw new Error(`No pane ${key}`);
      const inner = options.fetch ?? fetch;
      const app = runtime.lucioleClient.createApplication({
        ...options,
        // The instance travels with every request; the Server writes it into the ids.
        fetch:
          routeBy === "instance"
            ? (input, init) => {
                const headers = new Headers(init.headers);
                headers.set(INSTANCE_HEADER, key);
                return inner(input, { ...init, headers });
              }
            : options.fetch,
        routeTree: bundle.routeTree,
        buildId: bundle.buildId,
        resolveModule,
      });
      pane.modules = bundle.modules;
      pane.app = app;
      return app;
    },
    /** How many Client References pane `key`'s modules resolved. */
    resolutions: (key: string) => panes.get(key)?.resolved ?? 0,
  };
}

/**
 * The renderer's keymap host, deaf while `active()` is false. Each embed gets its own
 * Keymap over it: an application's global bindings (Ctrl+R, `?`) only fire in the
 * embed that has the keys, like a tmux pane. Focus-scoped layers keep working as is.
 */
function scopedHost(
  host: KeymapHost<Renderable, KeyEvent>,
  active: () => boolean,
): KeymapHost<Renderable, KeyEvent> {
  const gated =
    <T,>(listen: (listener: (event: T) => void) => () => void) =>
    (listener: (event: T) => void) =>
      listen((event) => {
        if (active()) listener(event);
      });
  return {
    get metadata() {
      return host.metadata;
    },
    rootTarget: host.rootTarget,
    get isDestroyed() {
      return host.isDestroyed;
    },
    getFocusedTarget: () => host.getFocusedTarget(),
    getParentTarget: (target) => host.getParentTarget(target),
    isTargetDestroyed: (target) => host.isTargetDestroyed(target),
    onKeyPress: gated((l) => host.onKeyPress(l)),
    onKeyRelease: gated((l) => host.onKeyRelease(l)),
    onFocusChange: (listener) => host.onFocusChange(listener),
    onDestroy: host.onDestroy && ((listener) => host.onDestroy?.(listener) ?? (() => {})),
    onTargetDestroy: (target, listener) => host.onTargetDestroy(target, listener),
    createCommandEvent: () => host.createCommandEvent(),
  };
}

class Gate {
  open: boolean;
  constructor(open: boolean) {
    this.open = open;
  }
  set(open: boolean) {
    this.open = open;
  }
}
function embedKeymap(renderer: CliRenderer, gate: Gate) {
  const keymap = new Keymap(scopedHost(createOpenTuiKeymapHost(renderer), () => gate.open));
  registerDefaultKeys(keymap);
  registerEnabledFields(keymap);
  registerMetadataFields(keymap);
  return keymap;
}

/** A crash in one embed replaces that embed only; without it React unmounts every embed. */
export class EmbedBoundary extends Component<
  { name: string; children: ReactNode },
  { error?: unknown }
> {
  override state: { error?: unknown } = {};
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  override render() {
    if (this.state.error === undefined) return this.props.children;
    return <text fg="#ff6b6b">{`${this.props.name} crashed: ${messageOf(this.state.error)}`}</text>;
  }
}

/** `Shell` of src/client.tsx for one embed: its own scoped keymap, its own boundary. */
export function EmbedShell({
  runtime,
  app,
  name,
  active,
  children,
}: {
  runtime: Runtime;
  app: Application;
  name: string;
  active: boolean;
  children?: ReactNode;
}) {
  const renderer = useRenderer();
  // Read by the keymap host on every key, outside render: a mutable gate, not state.
  const [gate] = useState(() => new Gate(active));
  useLayoutEffect(() => gate.set(active));
  const [keymap] = useState(() => embedKeymap(renderer, gate));
  const { RouterProvider } = runtime.tanstack;
  const { Runtime: RuntimeContext } = runtime.runtimeContext;
  return (
    <box
      id={`embed-${name}`}
      flexDirection="column"
      flexGrow={1}
      flexBasis={0}
      border
      borderColor={active ? "#67d9bc" : "#526d82"}
    >
      <EmbedBoundary name={name}>
        <KeymapProvider keymap={keymap}>
          <RuntimeContext.Provider value={app}>
            <RouterProvider router={app.router} />
            {children}
          </RuntimeContext.Provider>
        </KeymapProvider>
      </EmbedBoundary>
    </box>
  );
}
