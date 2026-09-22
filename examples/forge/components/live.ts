import { useSyncExternalStore } from "react";

// A Flight async iterable can be read once, but a cached route tree may remount its
// components. Each iterable is drained once into a store keyed by identity; every
// mount subscribes to that store.
type State = { lines: readonly string[]; done: boolean; error: string };
type Live = { state: State; listeners: Set<() => void> };
const streams = new WeakMap<AsyncIterable<string>, Live>();

function drain(source: AsyncIterable<string>, live: Live) {
  const update = (next: Partial<State>) => {
    live.state = { ...live.state, ...next };
    for (const listener of live.listeners) listener();
  };
  void (async () => {
    try {
      for await (const line of source) update({ lines: [...live.state.lines, line] });
      update({ done: true });
    } catch (error: unknown) {
      update({ done: true, error: error instanceof Error ? error.message : "Stream interrupted" });
    }
  })();
}
function storeOf(source: AsyncIterable<string>) {
  let live = streams.get(source);
  if (!live) {
    live = { state: { lines: [], done: false, error: "" }, listeners: new Set() };
    streams.set(source, live);
    drain(source, live);
  }
  return live;
}

export function useLiveLines(source: AsyncIterable<string>): State {
  const live = storeOf(source);
  return useSyncExternalStore(
    (listener) => {
      live.listeners.add(listener);
      return () => {
        live.listeners.delete(listener);
      };
    },
    () => live.state,
  );
}
