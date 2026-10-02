import { useState, type ReactNode } from "react";
import type { CliRenderer, KeyEvent, Renderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider, useKeymap } from "@opentui/keymap/react";
import { useRenderer } from "@opentui/react";

type OpenTuiKeymap = Keymap<Renderable, KeyEvent>;

/**
 * The keymap of the application's `<KeymapProvider>`, or null without one.
 * `@opentui/keymap/react` exports no context, only `useKeymap`, which throws when there is
 * no provider: the throw comes after its `useContext`, so hooks keep their order.
 */
function useOptionalKeymap(): OpenTuiKeymap | null {
  try {
    return useKeymap();
  } catch {
    return null;
  }
}

// A keymap listens to its renderer for good (it has no dispose): one per renderer, shared
// by every canvas that has no provider, however often they mount.
const ownKeymaps = new WeakMap<CliRenderer, OpenTuiKeymap>();
function keymapFor(renderer: CliRenderer): OpenTuiKeymap {
  const known = ownKeymaps.get(renderer);
  if (known) return known;
  const keymap = createDefaultOpenTuiKeymap(renderer);
  ownKeymaps.set(renderer, keymap);
  return keymap;
}

/**
 * The canvas's bindings go through `useBindings` in every case. Inside the application's
 * `<KeymapProvider>` (luciole's Shell installs one), they join its layers: `<KeyHelp>`
 * lists them, and the application's own layers can shadow them. Without one, the canvas
 * provides a keymap of its own on the renderer.
 */
export function FlowKeymap({ children }: { children: ReactNode }) {
  const outer = useOptionalKeymap();
  const renderer = useRenderer();
  const [own] = useState(() => (outer ? null : keymapFor(renderer)));
  return own ? <KeymapProvider keymap={own}>{children}</KeymapProvider> : children;
}
