"use client";
import { NoteEditorFrame } from "./NoteFrame";
import { Input, KeyHelp, useBindings, useNavigate, useRestoredFields } from "airtty/client";
import { useDraft, type Note, type Snapshot, type SaveResult } from "./draft";
type Props = {
  initialNote: Note;
  saveAction: (s: Snapshot) => Promise<SaveResult>;
  resolveAction: (id: string) => Promise<SaveResult | null>;
};
export function NoteEditor({ initialNote, saveAction, resolveAction }: Props) {
  const { draft, edit, save, recover, discard } = useDraft(initialNote),
    navigate = useNavigate(),
    // The typed text survives a crash or a rebuild; it is forgotten once sent, and kept
    // again when the Server refuses it or never received it.
    fields = useRestoredFields("note"),
    send = () =>
      void save((snapshot) => fields.submit(() => saveAction(snapshot), { failed: (r) => !r.ok }));
  // A committed save refreshes the page by itself: the Server Function invalidates it.
  useBindings(
    () => ({
      bindings: [
        { key: "ctrl+s", cmd: send, desc: "save", group: "note" },
        { key: "escape", cmd: () => void navigate({ to: "/" }), desc: "list", group: "note" },
        { key: "ctrl+o", cmd: () => void recover(resolveAction), desc: "resolve", group: "note" },
        {
          key: "ctrl+d",
          cmd: () => {
            if (draft.pending) return;
            discard();
            fields.clear();
          },
          desc: "discard",
          group: "note",
        },
      ],
    }),
    [save, recover, discard, draft, navigate, saveAction, resolveAction, fields],
  );
  return (
    <NoteEditorFrame
      dirty={draft.dirty}
      field={
        <Input
          id={`note-${initialNote.id}`}
          name="note/text"
          focused
          value={draft.value}
          onInput={edit}
          onSubmit={send}
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
