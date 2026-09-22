"use client";
import { NoteEditorFrame } from "./NoteFrame";
import { useKeyboard } from "@opentui/react";
import {
  useDraft,
  useNavigate,
  useRouter,
  type Note,
  type Snapshot,
  type SaveResult,
} from "airtty/client";
type Props = {
  initialNote: Note;
  saveAction: (s: Snapshot) => Promise<SaveResult>;
  resolveAction: (id: string) => Promise<SaveResult | null>;
};
export function NoteEditor({ initialNote, saveAction, resolveAction }: Props) {
  const { draft, edit, save, recover, discard } = useDraft(initialNote),
    navigate = useNavigate(),
    router = useRouter();
  // A committed save changes Server data: refresh the page (title, version). Not awaited,
  // so a failed refresh never turns the confirmed result into a failure.
  const refreshAfter = <T extends SaveResult | null>(result: T): T => {
    if (result?.ok) void router.invalidate().catch(() => {});
    return result;
  };
  const saveAndRefresh = async (snapshot: Snapshot) => refreshAfter(await saveAction(snapshot));
  const resolveAndRefresh = async (id: string) => refreshAfter(await resolveAction(id));
  useKeyboard((key) => {
    if (key.name === "escape") void navigate({ to: "/" });
    if (key.ctrl && key.name === "s") void save(saveAndRefresh);
    if (key.ctrl && key.name === "o") void recover(resolveAndRefresh);
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
          onSubmit={() => void save(saveAndRefresh)}
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
