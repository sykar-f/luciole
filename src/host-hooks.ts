/**
 * Hooks over `host` (src/host.ts), for Client Components: the same channel as the pane's
 * own `host` (the Application the pane's runtime copy provides), with the subscription
 * tied to the component's lifetime and the capability state kept current.
 */
import { useContext, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { createHost, type CapabilityState, type GlobalKey, type MediatedCapability } from "./host";
import { Runtime } from "./runtime-context";

function usePaneHost() {
  const app = useContext(Runtime);
  if (!app) throw new Error("Missing terminal shell");
  return app;
}
/** The latest `value`, for a subscription that outlives renders. */
function useLatest<T>(value: T) {
  const latest = useRef(value);
  useLayoutEffect(() => {
    latest.current = value;
  });
  return latest;
}

/** Messages other tabs post (`tabs.message`), while the component is mounted. */
export function useHostMessage(listener: (message: unknown, from: string) => void) {
  const app = usePaneHost();
  const latest = useLatest(listener);
  useEffect(
    () => createHost(() => app).tabs.onMessage((message, from) => latest.current(message, from)),
    [app, latest],
  );
}

/** `ctrl+shift+s` → what a `GlobalKey` must be; `alt` and `meta` are one modifier. */
function keyMatcher(key: string) {
  const parts = key.toLowerCase().split("+");
  const name = parts.at(-1) ?? "";
  const mods = new Set(parts.slice(0, -1));
  return (pressed: GlobalKey) =>
    pressed.name.toLowerCase() === name &&
    pressed.ctrl === mods.has("ctrl") &&
    pressed.shift === mods.has("shift") &&
    pressed.meta === (mods.has("meta") || mods.has("alt"));
}
/**
 * `key` (`"ctrl+s"`, `"f5"`) typed while another pane has the focus (`input.global`),
 * while the component is mounted.
 */
export function useGlobalKey(key: string, listener: (key: GlobalKey) => void) {
  const app = usePaneHost();
  const latest = useLatest(listener);
  useEffect(() => {
    const matches = keyMatcher(key);
    return createHost(() => app).input.onGlobalKey((pressed) => {
      if (matches(pressed)) latest.current(pressed);
    });
  }, [app, key, latest]);
}

/**
 * Where `capability` stands for this application: `granted`, `denied`, or `prompt` (the
 * host asks the user at the first request). Re-renders when the user decides. Outside
 * the sandbox, always `granted`: nothing is enforced there.
 */
export function useCapability(capability: MediatedCapability): CapabilityState {
  const app = usePaneHost();
  return useSyncExternalStore(
    (changed) =>
      app.host.listen((event) => {
        if (event.type === "capability" && event.capability === capability) changed();
      }),
    () => app.host.state(capability),
  );
}
