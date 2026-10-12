"use client";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

/** An app's view of a backend it depends on, separate from luciole's connection. */
export type UpstreamStatus = {
  label: string;
  state: "ok" | "degraded" | "down" | "unknown";
  detail?: string;
};

function createStatuses() {
  const publishers = new Map<string, UpstreamStatus>();
  let snapshot: readonly UpstreamStatus[] = [];
  const listeners = new Set<() => void>();
  return {
    get: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (id: string, status: UpstreamStatus | null) => {
      if (status) publishers.set(id, status);
      else if (!publishers.delete(id)) return;
      snapshot = [...publishers.values()];
      for (const listener of listeners) listener();
    },
  };
}
const Statuses = createContext<ReturnType<typeof createStatuses> | null>(null);

/** Mount once around the app's publishers and status UI; each provider is isolated. */
export function UpstreamStatusProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createStatuses);
  return <Statuses value={store}>{children}</Statuses>;
}
function useStatusesStore() {
  const store = useContext(Statuses);
  if (!store) throw new Error("Upstream status hooks need an UpstreamStatusProvider");
  return store;
}

/** Publish while mounted. Pass null to withdraw; unmounting withdraws automatically. */
export function usePublishUpstreamStatus(status: UpstreamStatus | null) {
  const store = useStatusesStore();
  const id = useId();
  const label = status?.label;
  const state = status?.state;
  const detail = status?.detail;
  useEffect(() => {
    store.set(
      id,
      label !== undefined && state !== undefined
        ? { label, state, ...(detail === undefined ? {} : { detail }) }
        : null,
    );
    return () => store.set(id, null);
  }, [store, id, label, state, detail]);
}

/** Read all mounted publishers in this provider, including from app test probes. */
export function useUpstreamStatuses(): readonly UpstreamStatus[] {
  const store = useStatusesStore();
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
