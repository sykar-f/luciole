import { caret, clampPos, contentOf, docEnd, range } from "../model/doc.ts";
import { slice } from "../model/inline.ts";
import { parseMarkdown } from "../markdown/parse.ts";
import { serializeMarkdown } from "../markdown/serialize.ts";
import {
  isText,
  type Block,
  type Doc,
  type MarkName,
  type Marks,
  type Pos,
  type Selection,
} from "../model/types.ts";
import {
  deleteForward,
  deleteSelection,
  deleteWordBackward,
  deleteWordForward,
  indentItems,
  insertLineBreak,
  insertMarkdown,
  selectAll,
  setBlockKind,
  toggleMark,
  toggleTask,
  type BlockKind,
} from "./commands.ts";
import {
  emptyHistory,
  record,
  redo,
  undo,
  type EditKind,
  type History,
  type Snapshot,
} from "./history.ts";
import { backspace, enter, settle, toMarkdown, typeText } from "./rules.ts";
import {
  createState,
  hasSelection,
  typingMarks,
  withSelection,
  type EditorState,
} from "./state.ts";

export type EditorChange = {
  readonly markdown: string;
  /** Whether the user changed the Markdown (a load or a move is not an edit). */
  readonly edited: boolean;
};

/**
 * An editor's state and what can be done to it, without a screen: the renderable feeds it
 * keys and clicks, an application's toolbar calls it directly (`toggleMark("bold")`).
 * Every change is one immutable state; undo keeps the previous ones.
 */
export class EditorController {
  private current: EditorState;
  private history: History = emptyHistory;
  private written: string;
  private readonly listeners = new Set<(change: EditorChange) => void>();

  constructor(markdown = "") {
    this.written = markdown;
    this.current = createState(parseMarkdown(markdown));
  }

  get state(): EditorState {
    return this.current;
  }
  /** The document as Markdown, as last reported. */
  get markdown(): string {
    return this.written;
  }

  subscribe(listener: (change: EditorChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit(edited: boolean) {
    const change = { markdown: this.written, edited };
    for (const listener of this.listeners) listener(change);
  }

  /**
   * Replaces the document (a note loaded, a version from elsewhere). The cursor stays
   * where it was when it still fits; undo starts over.
   */
  load(markdown: string): void {
    this.written = markdown;
    const doc = parseMarkdown(markdown);
    const { anchor, head } = this.current.selection;
    this.current = createState(doc, { anchor: clampPos(doc, anchor), head: clampPos(doc, head) });
    this.history = emptyHistory;
    this.emit(false);
  }

  /** Runs `edit` on the state, recording it for undo when it changed the document. */
  apply(edit: (state: EditorState) => EditorState, kind: EditKind = "other", text?: string): void {
    const before = this.current;
    const next = edit(before);
    if (next === before) return;
    this.current = next;
    if (next.doc === before.doc) {
      this.emit(false);
      return;
    }
    this.history = record(this.history, snapshotOf(before), kind, {
      now: Date.now(),
      ...(text === undefined ? {} : { text }),
    });
    this.report();
  }
  private report() {
    const markdown = toMarkdown(this.current);
    const edited = markdown !== this.written;
    this.written = markdown;
    this.emit(edited);
  }
  /** An edit that is not typing: pending delimiters are settled first. */
  private run(edit: (state: EditorState) => EditorState, kind: EditKind = "other") {
    this.apply((state) => edit(settle(state)), kind);
  }

  // Typing, as keys do it.
  type(text: string) {
    this.apply((state) => typeText(state, text), "type", text);
  }
  enter() {
    this.apply(enter);
  }
  lineBreak() {
    this.run(insertLineBreak);
  }
  backspace() {
    this.apply(backspace, "delete");
  }
  deleteForward() {
    this.run(deleteForward, "delete");
  }
  deleteWordBackward() {
    this.run(deleteWordBackward, "delete");
  }
  deleteWordForward() {
    this.run(deleteWordForward, "delete");
  }
  /** Pasted text, read as Markdown. */
  paste(markdown: string) {
    this.run((state) => insertMarkdown(state, markdown));
  }
  /** The selection removed, returned as Markdown (for a cut). */
  cut(): string {
    const text = this.selectedMarkdown();
    this.run(deleteSelection, "delete");
    return text;
  }

  // Formatting, as a toolbar does it.
  toggleMark(mark: MarkName) {
    this.run((state) => toggleMark(state, mark));
  }
  setBlock(kind: BlockKind) {
    this.run((state) => setBlockKind(state, kind));
  }
  indent(delta: 1 | -1) {
    this.run((state) => indentItems(state, delta));
  }
  toggleTask(block: number) {
    this.apply((state) => toggleTask(settle(state), block));
  }

  /** Delimiters still waiting for a key decided as if typing stopped (the focus left). */
  settle() {
    this.apply(settle);
  }

  // The cursor and the selection.
  select(selection: Selection) {
    this.apply((state) => withSelection(settle(state), selection));
  }
  moveTo(pos: Pos, options: { extend?: boolean } = {}) {
    const anchor = options.extend ? this.current.selection.anchor : pos;
    this.select({ anchor, head: pos });
  }
  selectAll() {
    this.run(selectAll);
  }
  /** The cursor at the end of the document. */
  end() {
    this.select(caret(docEnd(this.current.doc)));
  }

  undo() {
    const step = undo(this.history, snapshotOf(this.current));
    if (step) this.restore(step.history, step.snapshot);
  }
  redo() {
    const step = redo(this.history, snapshotOf(this.current));
    if (step) this.restore(step.history, step.snapshot);
  }
  private restore(history: History, snapshot: Snapshot) {
    this.history = history;
    this.current = withSelection({ ...this.current, doc: snapshot.doc }, snapshot.selection);
    this.report();
  }

  /** The marks the selection has throughout, or text typed now would take. */
  get activeMarks(): Marks {
    const state = this.current;
    if (!hasSelection(state)) return typingMarks(state);
    const spans = selectedSpans(state);
    const all = (mark: MarkName) =>
      spans.length > 0 && spans.every((span) => span.marks[mark] === true);
    return {
      ...(all("bold") ? { bold: true } : {}),
      ...(all("italic") ? { italic: true } : {}),
      ...(all("strike") ? { strike: true } : {}),
      ...(all("code") ? { code: true } : {}),
    };
  }
  /** The block the cursor is in. */
  get block(): Block | undefined {
    return this.current.doc[this.current.selection.head.block];
  }
  get canUndo() {
    return this.history.past.length > 0;
  }
  get canRedo() {
    return this.history.future.length > 0;
  }

  /** The selection as Markdown, for a copy. */
  selectedMarkdown(): string {
    const state = this.current;
    if (!hasSelection(state)) return "";
    const { from, to } = range(state.selection);
    const doc: Doc = state.doc.slice(from.block, to.block + 1).map((block, i) => {
      if (!isText(block) && block.type !== "code" && block.type !== "raw") return block;
      const start = i === 0 ? from.offset : 0;
      const end = from.block + i === to.block ? to.offset : Infinity;
      const content = slice(contentOf(block), start, end);
      return isText(block)
        ? { ...block, content, source: undefined }
        : { ...block, text: content.map((s) => s.text).join(""), source: undefined };
    });
    return serializeMarkdown(doc);
  }
}

const snapshotOf = (state: EditorState): Snapshot => ({
  doc: state.doc,
  selection: state.selection,
});

function selectedSpans(state: EditorState) {
  const { from, to } = range(state.selection);
  return state.doc.slice(from.block, to.block + 1).flatMap((block, i) => {
    if (!isText(block)) return [];
    const start = i === 0 ? from.offset : 0;
    const end = from.block + i === to.block ? to.offset : Infinity;
    return [...slice(block.content, start, end)];
  });
}
