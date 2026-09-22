import { useSyncExternalStore } from "react";
import { useServerChanged } from "./changes";
import type { OperationResult } from "./model";

// Unknown outcomes for operations that are not documents (review, merge, rerun).
// `useDraft` covers documents only, so the app keeps this small store itself: above the
// routes so an unknown merge survives navigation, cleared on identity change.
export type OperationState =
  | { status: "pending"; operationId: string; label: string }
  | { status: "unknown" | "unresolved"; operationId: string; label: string }
  | { status: "done"; operationId: string; label: string; result: OperationResult };

const entries = new Map<string, OperationState>();
const listeners = new Set<() => void>();
let revision = 0;
function changed() {
  revision++;
  for (const listener of listeners) listener();
}
export const operationStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  snapshot: () => revision,
  /** Operations whose outcome the user must still resolve. */
  unresolved: () => [...entries.values()].filter((e) => e.status !== "done"),
  clear() {
    entries.clear();
    changed();
  },
};

export function useOperation(key: string) {
  useSyncExternalStore(operationStore.subscribe, operationStore.snapshot);
  const changed = useServerChanged();
  const state = entries.get(key);
  const set = (next: OperationState) => {
    entries.set(key, next);
    changed();
  };
  // A confirmed change invalidates the routes; the result never waits for the refresh.
  const settle = (label: string, result: OperationResult) => {
    set({ status: "done", operationId: result.operationId, label, result });
    if (result.ok) changed();
  };
  const busy = state !== undefined && state.status !== "done";
  return {
    state,
    busy,
    /** Starts once: a pending or unknown operation blocks another attempt. */
    async run(label: string, action: (operationId: string) => Promise<OperationResult>) {
      if (busy) return;
      const operationId = crypto.randomUUID();
      set({ status: "pending", operationId, label });
      try {
        settle(label, await action(operationId));
      } catch {
        set({ status: "unknown", operationId, label });
      }
    },
    /** Looks the outcome up in the Server ledger. Never replays the operation. */
    async resolve(lookup: (operationId: string) => Promise<OperationResult | null>) {
      if (!state || (state.status !== "unknown" && state.status !== "unresolved")) return;
      try {
        const result = await lookup(state.operationId);
        if (result) settle(state.label, result);
        else set({ ...state, status: "unresolved" });
      } catch {
        set({ ...state, status: "unknown" });
      }
    },
    /** Explicit choice after a lookup found nothing: allows a new attempt. */
    forget() {
      if (state?.status === "unresolved" || state?.status === "done") {
        entries.delete(key);
        changed();
      }
    },
  };
}

export function describe(state: OperationState | undefined) {
  if (!state) return "";
  if (state.status === "pending") return `${state.label}…`;
  if (state.status === "unknown")
    return `${state.label}: outcome unknown · Ctrl+O resolve (never replayed)`;
  if (state.status !== "done")
    return `${state.label}: nothing committed yet · Ctrl+O again or Ctrl+X to forget`;
  return state.result.ok ? state.result.message : `${state.label} refused: ${state.result.error}`;
}
