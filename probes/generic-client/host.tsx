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
import type { Application, ApplicationOptions } from "../../src/client";
import { messageOf } from "../../src/guards";
import type { AbiSpecifier } from "./abi";
import type { LoadedBundle } from "./loader";
import { abiModules, type Runtime } from "./runtime";

/**
 * Several applications in one Client process, one Application each. Stands for the
 * refactor proposed in docs/EMBEDDING.md, done from outside src/:
 *
 * - `resolveModule`: one router for every Application, by the id's prefix (the build ID
 *   the Server wrote). React Flight's browser codec reads the single global
 *   `__webpack_require__`, so per-Application resolvers overwrite one another.
 * - `abiFor(buildId)`: a per-origin `airtty/client` whose `actionReference` calls that
 *   origin's Application, instead of the process-wide `current` of src/client.tsx.
 */
export function createOrigins(runtime: Runtime) {
  const origins = new Map<string, { modules: LoadedBundle["modules"]; app?: Application }>();
  const prefixOf = (id: string) => id.slice(0, id.indexOf("/"));
  const resolveModule = (id: string) => {
    const module = origins.get(prefixOf(id))?.modules.get(id);
    if (!module) throw new Error(`Unknown Client module: ${id}`);
    return module;
  };
  const appOf = (buildId: string) => {
    const app = origins.get(buildId)?.app;
    if (!app) throw new Error(`No Application mounted for ${buildId}`);
    return app;
  };
  const base = abiModules(runtime);
  return {
    resolveModule,
    /** The ABI a bundle of `buildId` is evaluated against. */
    abiFor(buildId: string) {
      const client = {
        ...runtime.airttyClient,
        actionReference: (id: string) =>
          runtime.flight.createServerReference(id, (key: string, args: unknown[]) =>
            appOf(buildId).callServer(key, args),
          ),
      };
      return (specifier: AbiSpecifier) =>
        specifier === "airtty/client" ? client : base[specifier];
    },
    mount(
      bundle: LoadedBundle,
      options: Omit<ApplicationOptions, "routeTree" | "buildId" | "resolveModule">,
    ) {
      if (origins.get(bundle.buildId)?.app)
        throw new Error(`${bundle.buildId} is mounted: one Application per build in this probe`);
      origins.set(bundle.buildId, { modules: bundle.modules });
      const app = runtime.airttyClient.createApplication({
        ...options,
        routeTree: bundle.routeTree,
        buildId: bundle.buildId,
        resolveModule,
      });
      origins.set(bundle.buildId, { modules: bundle.modules, app });
      return app;
    },
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
