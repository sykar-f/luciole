"use client";
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
    <box flexDirection="column" gap={1}>
      <box border borderColor="#526d82" padding={1}>
        <input
          id={`note-${initialNote.id}`}
          focused
          value={draft.value}
          onInput={edit}
          onSubmit={() => void save(saveAction)}
          placeholder="Write a note…"
        />
      </box>
      <text fg={draft.dirty ? "#ffbc66" : "#67d9bc"}>
        {draft.unknown
          ? "Unknown outcome"
          : draft.pending
            ? "Saving…"
            : draft.dirty
              ? "Unsaved Draft"
              : "Saved"}{" "}
        · baseline: {draft.baseline || "(empty)"}
      </text>
      {draft.conflict ? (
        <text fg="#ffbc66">Server changed. Draft preserved; discard explicitly to reload.</text>
      ) : null}
      {draft.error ? <text fg="#ffbc66">{draft.error}</text> : null}
      <text fg="#8b98a5">Enter / Ctrl+S save · Esc list · Ctrl+O resolve · Ctrl+D discard</text>
    </box>
  );
}
