"use client";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { MouseEvent } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { MarkdownEditor, type MarkdownEditorRenderable } from "@luciole/editor";
import { renderMath } from "luciole/math";
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
 * How long a save may go unmentioned. A save answers well within a second, the site's
 * slowest simulated ping included, and the Client gives up on a request after 10 s:
 * past 3 s, a save still running is said to be slow, and one that failed is reported,
 * long before the user could think it done and quit.
 */
const QUIET_MS = 3000;
/** The first automatic retry waits a second, each next one twice as long, up to 15 s. */
const RETRY_FIRST_MS = 1000;
const RETRY_LAST_MS = 15_000;

/**
 * One note, the whole right side: Markdown shown as it reads, and written in place, as it
 * reads too (`@luciole/editor`): a click puts the cursor there.
 * Its Draft outlives the page (components/draft.ts). Saving is automatic and silent: the
 * line above the title stays empty while saves succeed, and speaks only when one is slow,
 * failing or refused, or, with autosave off, while a change is not saved yet.
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
  const { refresh, status } = useConnection();
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
  // A save the Server has not answered: its outcome is looked up, or it is sent again.
  const retry = () =>
    draft.unknown ? void recover(resolveAction, saveAction) : canSave ? send() : undefined;
  // An unknown save is settled first, conflict or not: keeping or dropping this Draft
  // needs to know whether it was written.
  const failing = draft.failures > 0 && (draft.unknown || !draft.conflict);
  // Retried by itself, waiting longer each time: most failures are a moment's.
  const waiting = failing && (draft.unknown ? !draft.resolving : canSave);
  // For timers and effects: the retry due now, if one is.
  const latestRetry = useRef(retry);
  useLayoutEffect(() => {
    latestRetry.current = waiting ? retry : () => undefined;
  });
  useEffect(() => {
    if (!waiting) return;
    const wait = Math.min(RETRY_FIRST_MS * 2 ** (draft.failures - 1), RETRY_LAST_MS);
    const timer = setTimeout(() => latestRetry.current(), wait);
    return () => clearTimeout(timer);
  }, [waiting, draft.failures]);
  // And at once when the connection comes back.
  const online = status === "Connected";
  useEffect(() => {
    if (online) latestRetry.current();
  }, [online]);
  // Quiet for QUIET_MS after a save starts, a note reopened past that time included.
  const since = draft.since;
  const [expired, expire] = useState<number>();
  const quiet = since === undefined || expired !== since;
  useEffect(() => {
    if (since === undefined) return;
    const timer = setTimeout(() => expire(since), Math.max(0, since + QUIET_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [since]);

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
        // Saves now, or retries now what failed.
        { key: "ctrl+s", cmd: () => (failing ? retry() : canSave ? send() : undefined) },
        { key: "ctrl+e", cmd: () => (editing ? done() : startEditing()) },
        ...(editing ? [{ key: "escape", cmd: done }] : []),
        ...(focus === null ? [{ key: "return", cmd: startEditing }] : []),
      ],
    }),
    [editing, focus, canSave, failing, draft],
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
      status={
        draft.conflict && !(failing && !quiet) ? (
          <StatusLine
            fg={color.warn}
            text={
              behind
                ? "Changed elsewhere. Fetching that version…"
                : "Changed elsewhere. Your text is kept here."
            }
          >
            <Button
              tone="primary"
              disabled={behind || !!draft.pending}
              onPress={() => {
                adopt();
                send();
              }}
            >
              Keep mine
            </Button>
            <Button
              disabled={behind || !!draft.pending}
              onPress={() => {
                discard();
                fields.clear();
              }}
            >
              Use theirs
            </Button>
          </StatusLine>
        ) : failing && !quiet ? (
          // Retries go on behind the message; it leaves when one succeeds.
          <StatusLine
            fg={color.warn}
            text={
              draft.unknown
                ? "Save not confirmed. Your text is kept here."
                : "Could not reach the Server. Your text is kept here."
            }
          >
            <Button
              tone="quiet"
              disabled={draft.resolving || !!(draft.pending && !draft.unknown)}
              onPress={retry}
            >
              {draft.unknown
                ? draft.resolving
                  ? "Checking…"
                  : "Check again"
                : draft.pending
                  ? "Retrying…"
                  : "Retry"}
            </Button>
          </StatusLine>
        ) : draft.error && !draft.failures && !draft.pending ? (
          // Refused by the Server: retrying the same text would change nothing.
          <StatusLine fg={color.warn} text={`Not saved: ${draft.error}`}>
            {canSave ? (
              <Button tone="quiet" onPress={send}>
                Retry
              </Button>
            ) : null}
          </StatusLine>
        ) : draft.pending && !quiet ? (
          <StatusLine fg={color.muted} text="Still saving…" />
        ) : !autosaveMs && canSave ? (
          // Without autosave, the list's mark for unsaved work, and the way to save it.
          <StatusLine fg={color.muted} text="● Unsaved">
            <Button tone="quiet" onPress={send}>
              Save
            </Button>
          </StatusLine>
        ) : null
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
          math={renderMath}
          flexGrow={1}
        />
      </box>
    </NotePane>
  );
}

/** One line of the save's state: its words, cut short before its buttons are. */
function StatusLine({ fg, text, children }: { fg: string; text: string; children?: ReactNode }) {
  return (
    <box flexDirection="row" flexGrow={1} gap={1}>
      <text id="note-status" flexShrink={1} wrapMode="none" truncate fg={fg}>
        {text}
      </text>
      {children}
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
