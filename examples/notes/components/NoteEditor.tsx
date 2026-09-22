"use client";
import { NoteEditorFrame } from "./NoteFrame";
import { useKeyboard } from "@opentui/react";
import {
  useDraft,
  useNavigation,
  type Note,
  type Snapshot,
  type SaveResult,
} from "@terminal/framework/client";
type Props = {
  initialNote: Note;
  saveAction: (s: Snapshot) => Promise<SaveResult>;
  resolveAction: (id: string) => Promise<SaveResult | null>;
};
export function NoteEditor({ initialNote, saveAction, resolveAction }: Props) {
  const { draft, edit, save, recover, discard } = useDraft(initialNote),
    { navigate } = useNavigation();
  useKeyboard((key) => {
    if (key.name === "escape") void navigate("/");
    if (key.ctrl && key.name === "s") void save(saveAction);
    if (key.ctrl && key.name === "o") void recover(resolveAction);
    if (key.ctrl && key.name === "d" && !draft.pending) discard();
  });
  return (
    <NoteEditorFrame
      dirty={draft.dirty}
      field={
        <input
          id={`note-${initialNote.id}`}
          focused
          value={draft.value}
          onInput={edit}
          onSubmit={() => void save(saveAction)}
          placeholder="Write a note…"
        />
      }
      status={
        <>
          {draft.unknown
            ? "Unknown outcome"
            : draft.pending
              ? "Saving…"
              : draft.dirty
                ? "Unsaved Draft"
                : "Saved"}{" "}
          · baseline: {draft.baseline || "(empty)"}
        </>
      }
      conflict={
        draft.conflict
          ? "Server changed. Draft preserved; discard explicitly to reload."
          : undefined
      }
      error={draft.error}
      help="Enter / Ctrl+S save · Esc list · Ctrl+O resolve · Ctrl+D discard"
    />
  );
}
