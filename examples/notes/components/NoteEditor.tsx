"use client";
import { NoteEditorFrame } from "./NoteFrame";
import { KeyHelp, useBindings, useNavigate } from "airtty/client";
import { useDraft, type Note, type Snapshot, type SaveResult } from "./draft";
type Props = {
  initialNote: Note;
  saveAction: (s: Snapshot) => Promise<SaveResult>;
  resolveAction: (id: string) => Promise<SaveResult | null>;
};
export function NoteEditor({ initialNote, saveAction, resolveAction }: Props) {
  const { draft, edit, save, recover, discard } = useDraft(initialNote),
    navigate = useNavigate();
  // A committed save refreshes the page by itself: the Server Function invalidates it.
  useBindings(
    () => ({
      bindings: [
        { key: "ctrl+s", cmd: () => void save(saveAction), desc: "save", group: "note" },
        { key: "escape", cmd: () => void navigate({ to: "/" }), desc: "list", group: "note" },
        { key: "ctrl+o", cmd: () => void recover(resolveAction), desc: "resolve", group: "note" },
        {
          key: "ctrl+d",
          cmd: () => {
            if (!draft.pending) discard();
          },
          desc: "discard",
          group: "note",
        },
      ],
    }),
    [save, recover, discard, draft, navigate, saveAction, resolveAction],
  );
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
      help={<KeyHelp inline groups={["note"]} />}
    />
  );
}
