import type { Item, Snapshot, Update } from "../model";

/**
 * The Client's copy of the session, rebuilt from the feed: the snapshot, then patches
 * applied in order. Unchanged items keep their identity, so their views are not drawn
 * again. A missing update (a gap in `seq`) asks for a new subscription instead of
 * guessing.
 */
export class FeedStore {
  private current: Snapshot;
  private seq = -1;
  private subscription = -1;
  private readonly listeners = new Set<() => void>();

  constructor(initial: Snapshot) {
    this.current = initial;
  }

  get = () => this.current;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /**
   * Applies the updates of `subscription` not seen yet; calls `gap` when one is missing,
   * so the caller subscribes again (a new subscription starts with a snapshot).
   */
  follow(subscription: number, updates: readonly Update[], gap: () => void) {
    if (subscription !== this.subscription) {
      this.subscription = subscription;
      this.seq = -1;
    }
    let next = this.current;
    for (const update of updates) {
      if (update.seq <= this.seq) continue;
      if (update.kind === "snapshot") next = update.snapshot;
      else if (update.seq !== this.seq + 1) {
        gap();
        return;
      } else next = patched(next, update);
      this.seq = update.seq;
    }
    if (next !== this.current) {
      this.current = next;
      for (const listener of this.listeners) listener();
    }
  }
}

function patched(snapshot: Snapshot, update: Update & { kind: "patch" }): Snapshot {
  let items: readonly Item[] = snapshot.items;
  if (update.removed.length) {
    const removed = new Set(update.removed);
    items = items.filter((item) => !removed.has(item.id));
  }
  if (update.items.length) {
    const next = [...items];
    const index = new Map(next.map((item, i) => [item.id, i]));
    for (const item of update.items) {
      const at = index.get(item.id);
      if (at === undefined) {
        index.set(item.id, next.length);
        next.push(item);
      } else next[at] = item;
    }
    items = next;
  }
  return { ...snapshot, ...update.fields, items };
}
