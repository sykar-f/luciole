export type Note = {
  id: string;
  title: string;
  value: string;
  version: number;
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
  | { ok: false; error: string; operationId: string };
export class Draft {
  value: string;
  baseline: string;
  revision = 0;
  version: number;
  pending?: Snapshot;
  unknown = false;
  error = "";
  conflict = false;
  constructor(
    readonly id: string,
    note: Note,
  ) {
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
      if (this.revision === pending.revision) this.value = result.note.value;
    } else this.error = result.error;
    this.pending = undefined;
    this.unknown = false;
  }
  markUnknown() {
    if (this.pending) {
      this.unknown = true;
      this.error = "Outcome unknown — reconnect and resolve";
    }
  }
  markUnresolved() {
    if (this.pending && this.unknown)
      this.error = "No committed result yet; resolve again later (no automatic replay)";
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
  discard(note: Note) {
    if (this.pending) throw new Error("Resolve the current operation before discarding");
    if (note.id !== this.id) throw new Error("Wrong document");
    this.value = this.baseline = note.value;
    this.version = note.version;
    this.revision++;
    this.error = "";
    this.conflict = false;
  }
}
export class DraftStore {
  private entries = new Map<string, Draft>();
  private listeners = new Set<() => void>();
  private revision = 0;
  constructor(readonly capacity = 32) {}
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
