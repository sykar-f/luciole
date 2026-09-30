"use client";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { MouseEvent } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { MarkdownEditor, type MarkdownEditorRenderable } from "@luciole/editor";
import {
  CapabilityDenied,
  host,
  useBindings,
  useConnection,
  useRestoredField,
  useRestoredFields,
} from "luciole/client";
import { renameNote } from "../actions/notes";
import { titleOf, useCommands } from "./commands";
import { useDraft, type Note, type SaveResult, type Snapshot } from "./draft";
import { NotePane, READING_WIDTH } from "./NoteFrame";
import { Separator, ToolbarActions } from "./Toolbar";
import { when } from "./format";
import { useTheme, type Palette } from "./theme";
import { Button } from "./ui";
import { ui, useUi } from "./ui-state";

type Props = {
  initialNote: Note;
  saveAction: (s: Snapshot) => Promise<SaveResult>;
  resolveAction: (id: string) => Promise<SaveResult | null>;
  /** How long after the last keystroke a change saves itself; 0 saves only on request. */
  autosaveMs: number;
};
/**
 * One note, the whole right side: Markdown shown as it reads, and written in place, as it
 * reads too (`@luciole/editor`): a click puts the cursor there.
 * Its Draft outlives the page (components/draft.ts); saving is automatic, and every
 * state a save can end in has its own words and, when one helps, its button.
 */
export function NoteEditor({ initialNote: note, saveAction, resolveAction, autosaveMs }: Props) {
  const { color, syntax } = useTheme();
  const renderer = useRenderer();
  const { focus, renaming } = useUi();
  const commands = useCommands();
  const { draft, edit, save, recover, discard, adopt } = useDraft(note);
  // The typed text survives a crash or a rebuild; it is forgotten once sent, and kept
  // again when the Server refuses it or never received it.
  const fields = useRestoredFields("note");
  const send = () =>
    void save((snapshot) => fields.submit(() => saveAction(snapshot), { failed: (r) => !r.ok }));
  const editing = focus === "title" || focus === "body";
  const canSave = draft.dirty && !draft.pending && !draft.conflict;
  const body = useRef<MarkdownEditorRenderable>(null);
  // Typed text is kept for this page like a named field's: a crash or a rebuild gives it back.
  const typed = useRestoredField("note/text", draft.value, edit);
  const { refresh } = useConnection();
  // A save refused for a newer version: the page is read again to learn which one. Until
  // it arrives, keeping this Draft would be refused the same way.
  const behind = draft.conflict && note.version <= draft.version;
  useEffect(() => {
    if (behind) void refresh();
  }, [behind, refresh]);

  // The latest `send`, for timers and cleanups that outlive the render that set them.
  const latest = useRef(send);
  useLayoutEffect(() => {
    latest.current = send;
  });
  // Saved a moment after the last keystroke, unless something needs the user first.
  const autosave = autosaveMs > 0 && canSave && !draft.error;
  useEffect(() => {
    if (!autosave) return;
    const timer = setTimeout(() => latest.current(), autosaveMs);
    return () => clearTimeout(timer);
  }, [draft.revision, autosave, autosaveMs]);
  // Leaving the note with a change not yet sent sends it: the Draft outlives the page.
  const leaving = useRef(autosave);
  useLayoutEffect(() => {
    leaving.current = autosave;
  });
  useEffect(
    () => () => {
      if (leaving.current) latest.current();
    },
    [],
  );
  // New notes and "Rename…" from a menu arrive with their title ready to type.
  useEffect(() => {
    if (renaming !== note.id) return;
    ui.rename(null);
    ui.focus("title");
  }, [renaming, note.id]);
  // Leaving the note (another one, the list) leaves editing too.
  useEffect(() => () => ui.focus(null), []);

  const startEditing = () => {
    ui.focus("body");
    body.current?.controller.end();
  };
  const done = () => {
    ui.focus(null);
    if (canSave) send();
  };
  useBindings(
    () => ({
      bindings: [
        { key: "ctrl+s", cmd: () => (canSave ? send() : undefined) },
        { key: "ctrl+e", cmd: () => (editing ? done() : startEditing()) },
        ...(editing ? [{ key: "escape", cmd: done }] : []),
        ...(focus === null ? [{ key: "return", cmd: startEditing }] : []),
      ],
    }),
    [editing, focus, canSave, draft],
  );

  const copy = async () => {
    try {
      await host.clipboard.write(draft.value);
      ui.toast({ text: "Copied as Markdown" });
      return;
    } catch (error: unknown) {
      if (error instanceof CapabilityDenied) {
        ui.toast({ text: "The clipboard is not available here" });
        return;
      }
    }
    const copied = renderer.isOsc52Supported() && renderer.copyToClipboardOSC52(draft.value);
    ui.toast({ text: copied ? "Copied as Markdown" : "The clipboard is not available here" });
  };

  return (
    <NotePane
      toolbar={
        <box flexDirection="row" flexGrow={1} gap={2}>
          <text flexShrink={0} wrapMode="none" fg={color.muted}>
            {when(note.updated)}
          </text>
          <SaveStatus
            color={color}
            state={
              draft.unknown
                ? { text: "Connection lost while saving", fg: color.warn }
                : draft.pending
                  ? { text: "Saving…", fg: color.muted }
                  : draft.error && !draft.conflict
                    ? { text: draft.error, fg: color.warn }
                    : draft.dirty
                      ? { text: "Edited", fg: color.muted }
                      : { text: "Saved", fg: color.ok }
            }
            action={
              draft.unknown ? (
                <Button tone="quiet" onPress={() => void recover(resolveAction)}>
                  Check again
                </Button>
              ) : canSave && (draft.error || !autosaveMs) ? (
                <Button tone="quiet" onPress={send}>
                  {draft.error ? "Retry" : "Save"}
                </Button>
              ) : null
            }
          />
        </box>
      }
      title={
        <Title
          note={note}
          color={color}
          editing={focus === "title"}
          onEdit={() => ui.focus("title")}
          onDone={() => startEditing()}
        />
      }
      notice={
        draft.conflict ? (
          <box flexDirection="row" gap={1} height={1} flexShrink={0}>
            <text flexShrink={1} wrapMode="none" fg={color.warn}>
              {behind
                ? "Changed elsewhere. Fetching that version…"
                : "Changed elsewhere. Your text is kept here."}
            </text>
            <Button
              tone="primary"
              disabled={behind}
              onPress={() => {
                adopt();
                send();
              }}
            >
              Keep mine
            </Button>
            <Button
              disabled={behind}
              onPress={() => {
                discard();
                fields.clear();
              }}
            >
              Use theirs
            </Button>
          </box>
        ) : null
      }
    >
      {/* The text is written where it is shown: "Write" puts the cursor at its end, for
          those who look for a button rather than click the page. Delete stands apart. */}
      <ToolbarActions>
        {editing ? (
          <Button id="done" tone="primary" onPress={done}>
            ✓ Done
          </Button>
        ) : (
          <Button id="edit" onPress={startEditing}>
            ✎ Write
          </Button>
        )}
        <Button tone="quiet" onPress={() => void copy()}>
          Copy
        </Button>
        <Separator />
        <Button id="delete-note" tone="danger" onPress={() => void commands.remove(note)}>
          Delete
        </Button>
      </ToolbarActions>
      <box flexDirection="column" flexGrow={1}>
        <MarkdownEditor
          ref={body}
          id={`note-${note.id}`}
          value={draft.value}
          onChange={(markdown) => {
            typed(markdown);
            edit(markdown);
          }}
          focused={focus === "body"}
          syntaxStyle={syntax}
          placeholder="Start writing… **bold**, # a title, - a list"
          onFocusRequest={() => ui.focus("body")}
          onLink={(url) => void host.openUrl(url).catch(() => undefined)}
          readingWidth={READING_WIDTH}
          flexGrow={1}
        />
      </box>
    </NotePane>
  );
}

/** How long "Saved" stays lit once a save lands, before it steps back. */
const SAVED_LIT_MS = 2000;
function SaveStatus({
  color,
  state,
  action,
}: {
  color: Palette;
  state: { text: string; fg: string };
  action: ReactNode;
}) {
  // "Saved" is news the moment it happens, then only the state of things: it is lit
  // briefly after a save, muted the rest of the time (and when a note opens saved).
  const saved = state.text === "Saved";
  const [lit, setLit] = useState(false);
  const wasSaved = useRef(saved);
  useEffect(() => {
    const landed = saved && !wasSaved.current;
    wasSaved.current = saved;
    setLit(landed);
    if (!landed) return;
    const timer = setTimeout(() => setLit(false), SAVED_LIT_MS);
    return () => clearTimeout(timer);
  }, [saved]);
  const fg = saved && !lit ? color.muted : state.fg;
  return (
    <box flexDirection="row" flexShrink={1} gap={1}>
      <text id="note-status" flexShrink={1} wrapMode="none" truncate fg={fg}>
        {saved ? <span fg={fg}>✓ </span> : ""}
        {state.text}
      </text>
      {action}
    </box>
  );
}

/** The note's name, large; click it to rename, Enter or a click elsewhere keeps it. */
function Title({
  note,
  color,
  editing,
  onEdit,
  onDone,
}: {
  note: Note;
  color: Palette;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
}) {
  const [title, setTitle] = useState(note.title);
  const [hovered, setHovered] = useState(false);
  const renderer = useRenderer();
  // Another rename (this Client's menu, or the Server's answer) replaces what is shown.
  const [shown, setShown] = useState(note.title);
  if (shown !== note.title) {
    setShown(note.title);
    setTitle(note.title);
  }
  const commit = () => {
    const next = title.trim();
    if (next === note.title) return;
    renameNote(note.id, next).catch((error: unknown) => {
      setTitle(note.title);
      ui.toast({
        text: `Could not rename: ${error instanceof Error ? error.message : "unknown error"}`,
      });
    });
  };
  // Leaving the title, however it happens, keeps what was typed.
  const wasEditing = useRef(editing);
  useEffect(() => {
    if (wasEditing.current && !editing) commit();
    wasEditing.current = editing;
  });
  if (editing)
    return (
      <box id="note-title" height={1} flexShrink={0} backgroundColor={color.button}>
        <input
          id="title-field"
          focused
          value={title}
          onInput={setTitle}
          onSubmit={onDone}
          placeholder="Title"
          backgroundColor="transparent"
          focusedBackgroundColor="transparent"
          textColor={color.accent}
          focusedTextColor={color.accent}
          placeholderColor={color.faint}
        />
      </box>
    );
  return (
    <box
      id="note-title"
      flexDirection="row"
      height={1}
      flexShrink={0}
      onMouseOver={() => {
        setHovered(true);
        renderer.setMousePointer("text");
      }}
      onMouseOut={() => {
        setHovered(false);
        renderer.setMousePointer("default");
      }}
      onMouseDown={(event: MouseEvent) => {
        event.stopPropagation();
        onEdit();
      }}
    >
      <text
        flexShrink={1}
        wrapMode="none"
        truncate
        fg={note.title.trim() ? color.accent : color.faint}
      >
        <strong>{titleOf(note)}</strong>
      </text>
      <text flexShrink={0} fg={color.faint}>
        {hovered ? "  ✎ Rename" : ""}
      </text>
    </box>
  );
}
