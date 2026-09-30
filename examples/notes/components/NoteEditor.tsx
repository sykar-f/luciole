"use client";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { MouseEvent, TextareaRenderable } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import {
  CapabilityDenied,
  host,
  Markdown,
  ScrollBox,
  Textarea,
  useBindings,
  useConnection,
  useRestoredFields,
} from "luciole/client";
import { renameNote } from "../actions/notes";
import { titleOf, useCommands } from "./commands";
import { useDraft, type Note, type SaveResult, type Snapshot } from "./draft";
import { NotePane } from "./NoteFrame";
import { sidebarWidth, when } from "./format";
import { useTheme, type Palette } from "./theme";
import { Button, Line } from "./ui";
import { ui, useUi } from "./ui-state";

/** The widest a line of rendered text runs, as on a printed page. */
const READING_WIDTH = 100;
/** From this width of the note, the text being written is rendered beside it. */
const PREVIEW_MIN_WIDTH = 96;

type Props = {
  initialNote: Note;
  saveAction: (s: Snapshot) => Promise<SaveResult>;
  resolveAction: (id: string) => Promise<SaveResult | null>;
  /** How long after the last keystroke a change saves itself; 0 saves only on request. */
  autosaveMs: number;
};
/**
 * One note, the whole right side: rendered Markdown to read, a click to write in it.
 * Its Draft outlives the page (components/draft.ts); saving is automatic, and every
 * state a save can end in has its own words and, when one helps, its button.
 */
export function NoteEditor({ initialNote: note, saveAction, resolveAction, autosaveMs }: Props) {
  const { color, syntax } = useTheme();
  const renderer = useRenderer();
  const { width } = useTerminalDimensions();
  const { focus, renaming, sidebar } = useUi();
  const commands = useCommands();
  const { draft, edit, save, recover, discard, adopt } = useDraft(note);
  // The typed text survives a crash or a rebuild; it is forgotten once sent, and kept
  // again when the Server refuses it or never received it.
  const fields = useRestoredFields("note");
  const send = () =>
    void save((snapshot) => fields.submit(() => saveAction(snapshot), { failed: (r) => !r.ok }));
  const editing = focus === "title" || focus === "body";
  const canSave = draft.dirty && !draft.pending && !draft.conflict;
  const body = useRef<TextareaRenderable>(null);
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
    const field = body.current;
    if (field) field.cursorOffset = field.plainText.length;
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

  const paneWidth = width - sidebarWidth(width, sidebar);
  const preview = editing && paneWidth >= PREVIEW_MIN_WIDTH;
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
        <>
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
          <Button tone="quiet" onPress={() => void copy()}>
            Copy
          </Button>
          <Button id="delete-note" tone="quiet" onPress={() => void commands.remove(note)}>
            Delete
          </Button>
          {editing ? (
            <Button id="done" tone="primary" onPress={done}>
              ✓ Done
            </Button>
          ) : (
            <Button id="edit" onPress={startEditing}>
              ✎ Edit
            </Button>
          )}
        </>
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
      <box flexDirection="row" flexGrow={1} gap={2}>
        {/* Mounted while reading too: text restored after a crash comes back through it. */}
        <box flexGrow={1} flexBasis={0} overflow="hidden" visible={editing}>
          <Textarea
            ref={body}
            id={`note-${note.id}`}
            name="note/text"
            focused={focus === "body"}
            value={draft.value}
            onChange={edit}
            placeholder="Start writing… Markdown works: # title, **bold**, - list"
            textColor={color.text}
            focusedTextColor={color.text}
            placeholderColor={color.faint}
            // As tall as the pane, not as its text: the field scrolls to its cursor.
            height="100%"
            onMouseDown={() => ui.focus("body")}
          />
        </box>
        {editing && !preview ? null : (
          <Reading
            color={color}
            label={preview ? "Preview" : undefined}
            onClick={editing ? undefined : startEditing}
          >
            {draft.value.trim() ? (
              <Markdown
                content={draft.value}
                // Written as it is typed: an open **, list or code fence reads as it will.
                streaming={editing}
                syntaxStyle={syntax}
                onLink={(url) => void host.openUrl(url).catch(() => undefined)}
              />
            ) : (
              <Line fg={color.faint}>
                {editing ? "Nothing to preview yet" : "Empty note — click to write"}
              </Line>
            )}
          </Reading>
        )}
      </box>
    </NotePane>
  );
}

function SaveStatus({
  color,
  state,
  action,
}: {
  color: Palette;
  state: { text: string; fg: string };
  action: ReactNode;
}) {
  return (
    <box flexDirection="row" flexShrink={1} gap={1}>
      <text id="note-status" flexShrink={1} wrapMode="none" truncate fg={state.fg}>
        {state.text === "Saved" ? <span fg={color.ok}>✓ </span> : ""}
        {state.text}
      </text>
      {action}
    </box>
  );
}

/** The rendered note: scrolls with the wheel, and a click (not a drag, not a link) edits it. */
function Reading({
  color,
  label,
  onClick,
  children,
}: {
  color: Palette;
  label?: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  const renderer = useRenderer();
  const pressed = useRef<{ x: number; y: number } | null>(null);
  return (
    <box flexDirection="column" flexGrow={1} flexBasis={0}>
      {label ? (
        <text height={1} flexShrink={0} fg={color.faint}>
          {label}
        </text>
      ) : null}
      <ScrollBox
        id="note-view"
        name="note/scroll"
        flexGrow={1}
        scrollY
        onMouseDown={(event: MouseEvent) => {
          pressed.current = { x: event.x, y: event.y };
        }}
        onMouseUp={(event: MouseEvent) => {
          const start = pressed.current;
          pressed.current = null;
          if (!onClick || !start || start.x !== event.x || start.y !== event.y) return;
          if (!renderer.getLinkAt(event.x, event.y)) onClick();
        }}
        onMouseMove={() => (onClick ? renderer.setMousePointer("text") : undefined)}
        onMouseOut={() => renderer.setMousePointer("default")}
      >
        {/* A reading column: clear of the scrollbar, not wider than a page. */}
        <box flexDirection="column" flexShrink={0} maxWidth={READING_WIDTH} paddingRight={2}>
          {children}
        </box>
      </ScrollBox>
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
