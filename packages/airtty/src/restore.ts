import type { RouterHistory } from "@tanstack/react-router";

/**
 * What a browser keeps of a session: the history, and the text typed into the named
 * fields of each of its entries. Nothing else: page data comes back from the Server.
 */
export type SessionEntry = { href: string; fields: Record<string, string> };
export type Session = { index: number; entries: SessionEntry[] };
/** Where a field lives: an entry of the history, checked by its address. */
export type Place = { index: number; href: string };

/** Older entries are dropped first, as a browser caps its session history. */
export const MAX_ENTRIES = 50;
/** Longer text is not kept: a terminal field this long is a document, not a form. */
export const MAX_FIELD_LENGTH = 100_000;

const inGroup = (name: string, group: string) => name === group || name.startsWith(`${group}/`);

/**
 * The restorable part of a Client session, owned by the Application. It follows the
 * router's history and holds, per entry, the text the user typed into named fields.
 * Writing it to disk is `run()`'s job (src/session.ts); tests read `snapshot()`.
 */
export class Restoration {
  private entries: SessionEntry[];
  private index: number;
  private listeners = new Set<() => void>();
  // Fields cleared by a submit: they stay unsaved until the user types into them again,
  // so a value set by the application (the one sent) is never saved back.
  private sent = new Set<string>();
  constructor(session?: Session) {
    this.entries = session?.entries.map((e) => ({ href: e.href, fields: { ...e.fields } })) ?? [];
    this.index = session?.index ?? 0;
  }
  /**
   * Catches up with `history`: entries past its length were dropped by a push, and an
   * entry whose address changed is another page, whose fields start empty. Called on
   * every navigation and before every read: subscribing to the history itself would
   * stop TanStack Router from loading a router nobody renders.
   */
  sync(history: RouterHistory) {
    const { index, href } = this.current(history);
    let changed = index !== this.index;
    if (this.entries.length > history.length) {
      this.entries.length = history.length;
      for (const key of this.sent)
        if (Number(key.split("\n")[0]) >= history.length) this.sent.delete(key);
      changed = true;
    }
    if (this.entries[index]?.href !== href) {
      this.entries[index] = { href, fields: {} };
      changed = true;
    }
    this.index = index;
    if (changed) this.changed();
  }
  private current(history: RouterHistory): Place {
    return { index: history.location.state.__TSR_index, href: history.location.href };
  }
  /** The entry shown now: a field captures it when it mounts. */
  place(history: RouterHistory): Place {
    this.sync(history);
    return this.current(history);
  }
  private at({ index, href }: Place) {
    const entry = this.entries[index];
    return entry?.href === href ? entry : undefined;
  }
  get(place: Place, name: string): string | undefined {
    return this.at(place)?.fields[name];
  }
  /**
   * Keeps `value` for `name`. A `typed` value comes from the user and always counts; any
   * other change only updates text already kept, never re-saves text sent by a submit.
   */
  save(place: Place, name: string, value: string, { typed }: { typed: boolean }) {
    const entry = this.at(place);
    if (!entry) return;
    const key = `${place.index}\n${name}`;
    if (typed) this.sent.delete(key);
    else if (this.sent.has(key) || !(name in entry.fields)) return;
    if (value === "" || value.length > MAX_FIELD_LENGTH) {
      if (!(name in entry.fields)) return;
      delete entry.fields[name];
    } else if (entry.fields[name] === value) return;
    else entry.fields[name] = value;
    this.changed();
  }
  /** Forgets the fields of `group` at `place` and returns what they held. */
  take(place: Place, group: string): Record<string, string> {
    const entry = this.at(place);
    const taken: Record<string, string> = {};
    if (!entry) return taken;
    for (const name of Object.keys(entry.fields)) {
      if (!inGroup(name, group)) continue;
      taken[name] = entry.fields[name];
      delete entry.fields[name];
      this.sent.add(`${place.index}\n${name}`);
    }
    if (Object.keys(taken).length) this.changed();
    return taken;
  }
  /** Puts back text taken by `take`, unless the user typed something newer since. */
  restore(place: Place, taken: Record<string, string>) {
    const entry = this.at(place);
    if (!entry) return;
    for (const [name, value] of Object.entries(taken)) {
      const key = `${place.index}\n${name}`;
      if (!this.sent.has(key)) continue;
      this.sent.delete(key);
      entry.fields[name] = value;
    }
    this.changed();
  }
  /** Forgets every field of every entry; the history itself stays. */
  clear() {
    for (const entry of this.entries) if (entry) entry.fields = {};
    this.sent.clear();
    this.changed();
  }
  snapshot(): Session {
    const start = Math.max(0, this.entries.length - MAX_ENTRIES);
    return {
      index: Math.max(0, this.index - start),
      // Every navigation syncs, so no entry is missing; "/" only guards a hole.
      entries: Array.from(this.entries.slice(start), (e) => ({
        href: e?.href ?? "/",
        fields: { ...e?.fields },
      })),
    };
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private changed() {
    for (const listener of this.listeners) listener();
  }
}
