import { useSyncExternalStore } from "react";
import type { Identity } from "./model";

// Public identity for the persistent chrome. Layouts are Client Components and cannot
// read the Server session: the login flow stores what the Server returned, and the
// chrome asks `whoami()` only when it starts without it. Never an authorization.
let identity: Identity | null = null;
const listeners = new Set<() => void>();
export const sessionStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  get: () => identity,
  set(next: Identity | null) {
    identity = next;
    for (const listener of listeners) listener();
  },
};
export function useIdentity() {
  return useSyncExternalStore(sessionStore.subscribe, sessionStore.get);
}
