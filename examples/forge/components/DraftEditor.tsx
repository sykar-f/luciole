"use client";
import { useEffect, useRef } from "react";
import { useKeyboard } from "@opentui/react";
import type { TextareaRenderable } from "@opentui/core";
import { useDraft, type Note, type SaveResult, type Snapshot } from "@terminal/framework/client";
import { useServerChanged } from "./changes";
import { Line } from "./frames";
import { color } from "./theme";

type Props<R extends SaveResult> = {
  id: string;
  note: Note;
  editing: boolean;
  height: number;
  placeholder: string;
  save: (snapshot: Snapshot) => Promise<R>;
  resolve: (operationId: string) => Promise<R | null>;
  onSaved?: (result: R) => void;
  /** Business policy for a conflict: the Draft is kept until an explicit discard. */
  conflictHint?: string;
};

/**
 * A multi-line Draft: text survives navigation, typing continues during a save, an
 * unknown outcome is resolved from the ledger and never replayed.
 */
export function DraftEditor<R extends SaveResult>({
  id,
  note,
  editing,
  height,
  placeholder,
  save,
  resolve,
  onSaved,
  conflictHint = "Server changed · Draft kept · Ctrl+X reloads",
}: Props<R>) {
  const { draft, edit, save: saveDraft, recover, discard } = useDraft(note);
  const field = useRef<TextareaRenderable>(null);
  const changed = useServerChanged();
  // External changes (confirmation of an emptied composer, discard) reach the field.
  useEffect(() => {
    const current = field.current;
    if (current && current.plainText !== draft.value) current.setText(draft.value);
  }, [draft.value]);
  // Entering the editor continues the text where it ends.
  useEffect(() => {
    const current = field.current;
    if (editing && current) current.cursorOffset = current.plainText.length;
  }, [editing]);
  const confirmed = (result: R | null) => {
    if (result?.ok) {
      changed();
      onSaved?.(result);
    }
    return result;
  };
  const submit = () =>
    void saveDraft(async (snapshot) => {
      const result = await save(snapshot);
      confirmed(result);
      return result;
    });
  useKeyboard((key) => {
    if (key.ctrl && key.name === "o" && draft.unknown)
      void recover(async (operationId) => confirmed(await resolve(operationId)));
    if (!editing || !key.ctrl) return;
    if (key.name === "s") submit();
    if (key.name === "x" && !draft.pending) discard();
  });
  const status = draft.unknown
    ? "Outcome unknown · Ctrl+O resolve (never replayed)"
    : draft.pending
      ? "Publishing… keep typing"
      : draft.dirty
        ? "Unsaved Draft"
        : "Saved";
  return (
    <box flexDirection="column" flexShrink={0}>
      <box
        border
        borderColor={editing ? color.accent : color.border}
        height={height + 2}
        flexShrink={0}
      >
        <textarea
          id={id}
          ref={field}
          focused={editing}
          initialValue={draft.value}
          placeholder={placeholder}
          textColor={color.text}
          focusedTextColor={color.text}
          onContentChange={() => {
            if (field.current) edit(field.current.plainText);
          }}
        />
      </box>
      <Line
        id={`${id}-status`}
        fg={draft.conflict || draft.error || draft.unknown ? color.warn : color.muted}
      >
        {draft.error || (draft.conflict ? conflictHint : status)}
      </Line>
    </box>
  );
}
