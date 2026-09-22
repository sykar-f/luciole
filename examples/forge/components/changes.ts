import { useRouter } from "@terminal/framework/client";

// After a confirmed mutation the app refreshes two kinds of Server data: route loaders
// (TanStack invalidation) and reads made through Server Functions by the persistent
// chrome, which no route invalidation reaches. One entry point keeps both in step.
const listeners = new Set<() => void>();
export function onServerChange(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useServerChanged() {
  const router = useRouter();
  return () => {
    // Not awaited: a confirmed result never depends on the refresh.
    void router.invalidate().catch(() => {});
    for (const listener of listeners) listener();
  };
}
