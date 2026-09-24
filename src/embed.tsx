/** @jsxImportSource @opentui/react */
/**
 * Other airtty applications inside this one, one pane each: the `inline` mode of
 * docs/EMBEDDING.md (same process, same React tree, no isolation).
 *
 * Every built Client bundles its own copy of the airtty runtime, TanStack Router and the
 * keymap; React and OpenTUI are shared. A pane's hooks read the contexts of its own copy,
 * so the work splits in two:
 * - `<Embed>`, from the host's copy: the pane's frame, its error boundary, its focus, and
 *   which keys it may hear;
 * - `ApplicationView`, from the pane's copy (`app.view`): its keymap, router and
 *   `useApplication` context.
 */
import { Component, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { BoxRenderable, CliRenderer, KeyEvent, Renderable } from "@opentui/core";
import { CliRenderEvents } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { Keymap, type KeymapHost } from "@opentui/keymap";
import {
  registerDefaultKeys,
  registerEnabledFields,
  registerMetadataFields,
} from "@opentui/keymap/addons";
import { createOpenTuiKeymapHost } from "@opentui/keymap/opentui";
import { KeymapProvider, useKeymap } from "@opentui/keymap/react";
import { RouterProvider } from "@tanstack/react-router";
import type { Application } from "./client";
import { messageOf } from "./guards";
import { Runtime } from "./runtime-context";

/** Decides, key by key, whether a pane hears it. Read outside React, on every key. */
export type KeyGate = (event: KeyEvent) => boolean;

/**
 * The renderer's keymap host, deaf to the keys `gate` refuses. A pane's global bindings
 * (Ctrl+R, `?`) then fire only while it has the keys, like a tmux pane; its focus-scoped
 * layers keep working as they are.
 */
function gatedHost(
  host: KeymapHost<Renderable, KeyEvent>,
  gate: KeyGate,
): KeymapHost<Renderable, KeyEvent> {
  const gated =
    (listen: (listener: (event: KeyEvent) => void) => () => void) =>
    (listener: (event: KeyEvent) => void) =>
      listen((event) => {
        if (gate(event)) listener(event);
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
    onDestroy: (listener) => host.onDestroy?.(listener) ?? (() => {}),
    onTargetDestroy: (target, listener) => host.onTargetDestroy(target, listener),
    createCommandEvent: () => host.createCommandEvent(),
  };
}
/** `createDefaultOpenTuiKeymap`, over a gated host. */
function paneKeymap(renderer: CliRenderer, gate: KeyGate) {
  const keymap = new Keymap(gatedHost(createOpenTuiKeymapHost(renderer), gate));
  registerDefaultKeys(keymap);
  registerEnabledFields(keymap);
  registerMetadataFields(keymap);
  return keymap;
}

/** What `Shell` is to a Client, for one pane: rendered by `<Embed>` through `app.view`. */
export function ApplicationView({ app, gate }: { app: Application; gate: KeyGate }) {
  const renderer = useRenderer();
  const [keymap] = useState(() => paneKeymap(renderer, gate));
  return (
    <KeymapProvider keymap={keymap}>
      <Runtime.Provider value={app}>
        <RouterProvider router={app.router} />
      </Runtime.Provider>
    </KeymapProvider>
  );
}

/** A crash in one pane replaces that pane; without it OpenTUI's root boundary takes all. */
class PaneBoundary extends Component<{ name: string; children: ReactNode }, { error?: unknown }> {
  override state: { error?: unknown } = {};
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  override render() {
    if (this.state.error === undefined) return this.props.children;
    return (
      <text
        fg="#ff6b6b"
        wrapMode="word"
      >{`${this.props.name} crashed: ${messageOf(this.state.error)}`}</text>
    );
  }
}

// What the keymap host asks on every key, kept out of React state: a key never waits for
// a render.
class Keys {
  active = false;
  isPrefix: (event: KeyEvent) => boolean = () => false;
  hostPending: () => boolean = () => false;
  update(active: boolean, isPrefix: (event: KeyEvent) => boolean, hostPending: () => boolean) {
    this.active = active;
    this.isPrefix = isPrefix;
    this.hostPending = hostPending;
  }
  hears = (event: KeyEvent) => this.active && !this.isPrefix(event) && !this.hostPending();
}

const within = (node: Renderable | null, root: Renderable) => {
  for (let n = node; n; n = n.parent) if (n === root) return true;
  return false;
};

export type EmbedProps = {
  /** The pane's Application, from `openApplication` (one bundle evaluation per pane). */
  app: Application;
  /** Names the pane: its renderable id (`embed-<name>`) and its crash message. */
  name: string;
  /** Whether this pane has the keys; the host decides (a prefix key, a click). */
  active: boolean;
  /**
   * The host's key (`"ctrl+o"`), as for `<Terminal>`: it and the sequence it starts stay
   * with the host's bindings, even when the pane binds the same key.
   */
  prefix?: string;
  flexGrow?: number;
  width?: number | `${number}%`;
  height?: number | `${number}%`;
};

/**
 * An airtty application in a pane of this one. Keys reach it only while `active`, minus
 * the host's prefix; an inactive pane keeps nothing focused (what had the focus gets it
 * back when the pane becomes active again); an error in it stays in it.
 */
export function Embed(props: EmbedProps) {
  const renderer = useRenderer();
  const host = useKeymap();
  const box = useRef<BoxRenderable>(null);
  const [keys] = useState(() => new Keys());
  const prefix = props.prefix;
  useLayoutEffect(() => {
    const isPrefix = prefix ? host.createKeyMatcher(prefix) : () => false;
    keys.update(props.active, isPrefix, () => host.hasPendingSequence());
  });
  const remembered = useRef<Renderable | null>(null);
  useEffect(() => {
    const root = box.current;
    if (!root) return;
    if (props.active) {
      const saved = remembered.current;
      remembered.current = null;
      if (saved && !saved.isDestroyed) saved.focus();
      return;
    }
    // OpenTUI's focus is the renderer's: a focused input of an inactive pane would still
    // receive typing, bypassing every keymap. It is set aside, and so is any focus the
    // pane takes while inactive (a `focused` prop, a click before the host switches).
    const setAside = (focused: Renderable | null) => {
      if (!focused || !within(focused, root)) return;
      remembered.current = focused;
      focused.blur();
    };
    setAside(renderer.currentFocusedRenderable);
    renderer.on(CliRenderEvents.FOCUSED_RENDERABLE, setAside);
    return () => {
      renderer.off(CliRenderEvents.FOCUSED_RENDERABLE, setAside);
    };
  }, [renderer, props.active]);
  const View = props.app.view;
  return (
    <box
      ref={box}
      id={`embed-${props.name}`}
      flexDirection="column"
      flexGrow={props.flexGrow}
      width={props.width}
      height={props.height}
    >
      <PaneBoundary name={props.name}>
        <View app={props.app} gate={keys.hears} />
      </PaneBoundary>
    </box>
  );
}
