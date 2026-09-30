"use client";
import { useEffect, useSyncExternalStore } from "react";
import { TransportError } from "luciole/client";

// Application-owned session Drafts: the framework only reports what happened to a
// request (`TransportError.outcome`); keeping, resolving and clearing unsaved work is
// this application's policy.
export type Note = {
  id: string;
  title: string;
  value: string;
  version: number;
  /** Last change, in epoch milliseconds. */
  updated: number;
};
export type Snapshot = {
  id: string;
  value: string;
  version: number;
  revision: number;
  operationId: string;
};
export type SaveResult =
  | { ok: true; note: Note; operationId: string }
  /** `conflict`: the note changed since the Draft's version; nothing was written. */
  | { ok: false; error: string; operationId: string; conflict?: boolean };
export class Draft {
  value: string;
  baseline: string;
  revision = 0;
  version: number;
  pending?: Snapshot;
  unknown = false;
  /** An unknown outcome is being looked up (`recover`). */
  resolving = false;
  error = "";
  conflict = false;
  /** When the first attempt of the save the Server has not answered yet began. */
  since?: number;
  /** Attempts in a row that ended without the Server's answer: each retry waits longer. */
  failures = 0;
  readonly id: string;
  constructor(id: string, note: Note) {
    this.id = id;
    this.value = this.baseline = note.value;
    this.version = note.version;
  }
  get dirty() {
    return this.value !== this.baseline;
  }
  edit(value: string) {
    if (value !== this.value) {
      this.value = value;
      this.revision++;
      this.error = "";
    }
  }
  begin(): Snapshot {
    if (this.pending) throw new Error("Resolve the current operation before saving");
    const snapshot = {
      id: this.id,
      value: this.value,
      version: this.version,
      revision: this.revision,
      operationId: crypto.randomUUID(),
    };
    this.pending = snapshot;
    this.unknown = false;
    this.error = "";
    this.since ??= Date.now();
    return snapshot;
  }
  confirm(result: SaveResult) {
    const pending = this.pending;
    if (!pending || pending.operationId !== result.operationId) return;
    if (result.ok && result.note.id !== this.id) return;
    if (result.ok) {
      this.baseline = result.note.value;
      this.version = result.note.version;
      this.conflict = false;
      this.error = "";
      if (this.revision === pending.revision) this.value = result.note.value;
    } else {
      this.error = result.error;
      if (result.conflict) this.conflict = true;
    }
    this.pending = undefined;
    this.unknown = false;
    this.resolving = false;
    // The Server answered, yes or no: nothing is left to retry.
    this.since = undefined;
    this.failures = 0;
  }
  /** The Server provably did not run the save: the Draft stays dirty and can be retried. */
  fail(error: string) {
    if (!this.pending) return;
    this.pending = undefined;
    this.unknown = false;
    this.error = error;
    this.failures++;
  }
  markUnknown() {
    if (this.pending) {
      this.unknown = true;
      this.resolving = false;
      this.error = "Outcome unknown — reconnect and resolve";
      this.failures++;
    }
  }
  /** The unknown save to look up, marked as being looked up; nothing if there is none. */
  lookUp(): Snapshot | undefined {
    if (!this.pending || !this.unknown || this.resolving) return undefined;
    this.resolving = true;
    return this.pending;
  }
  receive(note: Note) {
    // Restoring a previous route may replay props older than an in-flight save's confirmation.
    if (note.id !== this.id || note.version <= this.version) return;
    if (this.dirty || this.pending) {
      this.conflict = true;
      return;
    }
    this.value = this.baseline = note.value;
    this.version = note.version;
    this.revision++;
  }
  /**
   * Keeps this Draft over a note changed elsewhere: the next save replaces `note`,
   * the version the Server has now, instead of failing on the one the Draft started from.
   */
  adopt(note: Note) {
    if (this.pending) throw new Error("Resolve the current operation before keeping this Draft");
    if (note.id !== this.id) throw new Error("Wrong document");
    this.baseline = note.value;
    this.version = note.version;
    this.error = "";
    this.conflict = false;
  }
  discard(note: Note) {
    if (this.pending) throw new Error("Resolve the current operation before discarding");
    if (note.id !== this.id) throw new Error("Wrong document");
    this.value = this.baseline = note.value;
    this.version = note.version;
    this.revision++;
    this.error = "";
    this.conflict = false;
    this.since = undefined;
    this.failures = 0;
  }
}
export class DraftStore {
  private entries = new Map<string, Draft>();
  private listeners = new Set<() => void>();
  private revision = 0;
  readonly capacity: number;
  constructor(capacity = 32) {
    this.capacity = capacity;
  }
  get(note: Note) {
    let draft = this.entries.get(note.id);
    if (!draft) {
      if (this.entries.size >= this.capacity) {
        const clean = [...this.entries].find(([, d]) => !d.dirty && !d.pending);
        if (!clean) throw new Error("Draft capacity reached: save or discard a visited note");
        this.entries.delete(clean[0]);
      }
      draft = new Draft(note.id, note);
      this.entries.set(note.id, draft);
    }
    return draft;
  }
  get size() {
    return this.entries.size;
  }
  /** Drafts whose loss would lose work: dirty, in flight or with an unknown outcome. */
  unsaved() {
    return [...this.entries.values()].filter((d) => d.dirty || d.pending);
  }
  /**
   * Forgets every Draft. Drafts belong to the identity that typed them: a new bearer
   * must never show, or submit under its own name, another account's unsaved work.
   */
  clear() {
    this.entries.clear();
    this.changed();
  }
  subscribe = (f: () => void) => {
    this.listeners.add(f);
    return () => {
      this.listeners.delete(f);
    };
  };
  snapshot = () => this.revision;
  changed = () => {
    this.revision++;
    for (const f of this.listeners) f();
  };
}

/** Above the routes: a Draft outlives its editor while navigating. */
export const drafts = new DraftStore();

export function useDraft(note: Note) {
  useSyncExternalStore(drafts.subscribe, drafts.snapshot);
  const draft = drafts.get(note);
  useEffect(() => {
    draft.receive(note);
    drafts.changed();
  }, [draft, note]);
  return {
    draft,
    edit: (value: string) => {
      draft.edit(value);
      drafts.changed();
    },
    discard: () => {
      draft.discard(note);
      drafts.changed();
    },
    adopt: () => {
      draft.adopt(note);
      drafts.changed();
    },
    save: async (action: (s: Snapshot) => Promise<SaveResult>) => {
      if (draft.pending) return;
      const snapshot = draft.begin();
      drafts.changed();
      try {
        draft.confirm(await action(snapshot));
      } catch (e) {
        // Only a request that may have run leaves an unknown outcome to resolve.
        if (e instanceof TransportError && e.outcome !== "unknown")
          draft.fail(`Not saved: ${e.message}`);
        else draft.markUnknown();
      }
      drafts.changed();
    },
    /**
     * Settles a save whose outcome is unknown: the Server's record of the operation if it
     * ran, else the same operation sent again. A save is idempotent by operation id, so
     * a copy arriving after the original is answered with the original's result.
     */
    recover: async (
      resolve: (id: string) => Promise<SaveResult | null>,
      resend: (s: Snapshot) => Promise<SaveResult>,
    ) => {
      const snapshot = draft.lookUp();
      if (!snapshot) return;
      drafts.changed();
      try {
        draft.confirm((await resolve(snapshot.operationId)) ?? (await resend(snapshot)));
      } catch {
        // Still unknown, whatever failed: the original may yet be written.
        draft.markUnknown();
      }
      drafts.changed();
    },
  };
}
