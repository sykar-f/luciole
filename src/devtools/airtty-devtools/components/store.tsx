"use client";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useApplication } from "airtty/client";
import { createSession, type Source, type Stored } from "../../model/session";
import { subscribe } from "../actions/bus";

/**
 * The DevTools' Client state: one `Session` model fed by the live feed of the DevTools'
 * Server. It lives in the root layout, above the routes, so switching panels keeps it;
 * panels read it through `useDevtools()` and re-render at most every `NOTIFY_MS`.
 */
const NOTIFY_MS = 100;
const RETRY_MS = 1000;
export type Connect = { address: string; hook?: string };
type Batch = {
  events: Stored[];
  missed: number;
  sources: Source[];
  rejected: number;
  connect: Connect;
};

class Store {
  session = createSession();
  version = 0;
  paused = false;
  missed = 0;
  rejected = 0;
  connect: Connect | undefined;
  /** A panel's text field has the keyboard: single-key bindings stand down. */
  typing = false;
  /** Events received while paused, applied on resume. */
  private held: Stored[] = [];
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  snapshot = () => this.version;
  private notify() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.version++;
      for (const listener of this.listeners) listener();
    }, NOTIFY_MS);
  }
  apply(batch: Batch) {
    this.missed += batch.missed;
    this.rejected = batch.rejected;
    this.connect = batch.connect;
    if (this.paused) this.held.push(...batch.events);
    else for (const stored of batch.events) this.session.add(stored);
    this.session.setSources(batch.sources);
    this.notify();
  }
  togglePause() {
    this.paused = !this.paused;
    if (!this.paused) for (const stored of this.held.splice(0)) this.session.add(stored);
    this.notify();
  }
  setTyping(typing: boolean) {
    this.typing = typing;
    this.version++;
    for (const listener of this.listeners) listener();
  }
  clear() {
    this.session.clear();
    this.held = [];
    this.notify();
  }
}

const StoreContext = createContext<Store | null>(null);

/** Opens the live feed once, and again after a failure, resuming after the last event. */
export function DevtoolsProvider({ children }: { children: ReactNode }) {
  const app = useApplication();
  const [store] = useState(() => new Store());
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          // A Server Function reference answers with a promise of the stream.
          const feed = await Promise.resolve(
            app.withSignal(controller.signal, () => subscribe(store.session.last()), "live"),
          );
          for await (const batch of feed) store.apply(batch);
        } catch {
          // The DevTools' own Server restarted or the stream was cut: resume.
        }
        await new Promise((done) => setTimeout(done, RETRY_MS));
      }
    })();
    return () => controller.abort();
  }, [app, store]);
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useDevtools() {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useDevtools() outside the DevTools layout");
  useSyncExternalStore(store.subscribe, store.snapshot);
  return store;
}

const epoch = () => performance.timeOrigin + performance.now();
/**
 * The time, refreshed every `ms` while `active` (live bars grow, ages tick), and for
 * `burst.duration` after `burst.key` changes (a flash fades).
 */
export function useTicker(ms: number, active: boolean, burst?: { key: unknown; duration: number }) {
  const [now, setNow] = useState(epoch);
  const key = burst?.key;
  const duration = burst?.duration ?? 0;
  useEffect(() => {
    if (!active && !duration) return;
    const started = epoch();
    const timer = setInterval(() => {
      const time = epoch();
      setNow(time);
      if (!active && time - started > duration) clearInterval(timer);
    }, ms);
    return () => clearInterval(timer);
  }, [ms, active, key, duration]);
  return now;
}
