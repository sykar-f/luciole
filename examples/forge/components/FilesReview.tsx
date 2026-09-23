"use client";
import { Suspense, use, useEffect, useMemo, useRef, useState } from "react";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import type { DiffRenderable, ScrollBoxRenderable } from "@opentui/core";
import { TransportError, useBindings } from "airtty/client";
import { fileSource, publish, resolveSave } from "../actions/pulls";
import { drafts } from "./draft";
import { DraftEditor } from "./DraftEditor";
import { useEditing, useEditingWhile } from "./editing";
import { openInEditor } from "./editor";
import { Line, SkeletonRows } from "./frames";
import type { Comment, FileDiff, FileSource, FileSummary, PullDetail, Side } from "./model";
import { Pulse } from "./Pulse";
import { useReviewSession } from "./review-session";
import { syntax } from "./syntax";
import { color } from "./theme";

// Page Up/Down move the cursor this many rows; the file's latest comments stay listed.
const PAGE_ROWS = 20,
  COMMENTS_SHOWN = 4;
export type ReviewFile = FileSummary & { diff: Promise<FileDiff | null>; comments: Comment[] };
type Props = {
  pull: PullDetail;
  files: ReviewFile[];
  composerVersions: Record<string, number>;
  canComment: boolean;
};

const SPLIT_WIDTH = 170;
const CURSOR_BG = "#2d3f52";
const lineSlot = (pull: PullDetail, side: Side, line: number, path: string) =>
  `composer:line:${pull.id}:${pull.revision}:${side}:${line}:${path}`;
/** `report@r2.ts`, `report@r2.old.ts`: the editor still recognises the extension. */
const snapshotName = ({ path, revision, side }: FileSource) => {
  const name = path.split("/").at(-1) ?? "file";
  const dot = name.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  return `${stem}@r${revision}${side === "old" ? ".old" : ""}${extension}`;
};

/**
 * The file list is usable at once; each diff is a Promise streamed by Flight and
 * resolved under its own Suspense boundary. Selection, cursor, viewed marks and split
 * view are local and persist across tabs through the pull request layout.
 */
export function FilesReview({ pull, files, composerVersions, canComment }: Props) {
  const session = useReviewSession();
  const { width } = useTerminalDimensions();
  const { editing } = useEditing();
  const [composing, setComposing] = useState<{ side: Side; line: number } | null>(null);
  const [notice, setNotice] = useState("");
  useEditingWhile(composing !== null);
  const index = Math.max(
    0,
    files.findIndex((f) => f.path === session.file),
  );
  const file = files[index];
  const split = session.split ?? width >= SPLIT_WIDTH;
  const [anchor, setAnchor] = useState<{ side: Side; line: number } | null>(null);
  const renderer = useRenderer();
  const opening = useRef(false);

  const step = (delta: number) =>
    session.setFile(files[Math.max(0, Math.min(index + delta, files.length - 1))].path);
  const comment = () => {
    if (split) setNotice("Switch to unified view (s) to comment on a line");
    else if (!anchor) setNotice("Move the cursor to a diff line first (j/k)");
    else if (drafts.unsaved().length >= drafts.capacity)
      setNotice(`Draft limit reached (${drafts.capacity}): publish or discard a Draft first`);
    else {
      setNotice("");
      setComposing(anchor);
    }
  };
  // The Server gives the side of the file under the cursor, as reviewed (this revision);
  // the editor runs here, on the reviewer's terminal, with the UI suspended meanwhile.
  const edit = async () => {
    if (!file || opening.current) return;
    opening.current = true;
    const side = anchor?.side ?? "new";
    setNotice(`Fetching ${file.path} at revision ${pull.revision}…`);
    try {
      const source = await fileSource({
        repo: pull.repo,
        number: pull.number,
        revision: pull.revision,
        path: file.path,
        side,
      });
      if (!source) {
        setNotice(`${file.path} is not part of revision ${pull.revision}`);
        return;
      }
      const opened = await openInEditor(renderer, {
        name: snapshotName(source),
        content: source.content,
        line: anchor?.line,
      });
      setNotice(
        opened.edited
          ? `Edits discarded: ${snapshotName(source)} was a read-only snapshot`
          : opened.exitCode
            ? `${opened.editor} exited with code ${opened.exitCode}`
            : `Viewed ${snapshotName(source)} in ${opened.editor} (read-only snapshot)`,
      );
    } catch (error: unknown) {
      setNotice(
        error instanceof TransportError
          ? `Could not fetch ${file.path}: ${error.message}`
          : `Could not start the editor · set $EDITOR (${error instanceof Error ? error.message : "failed"})`,
      );
    } finally {
      opening.current = false;
    }
  };
  useBindings(
    () => ({
      bindings: [
        ...(composing
          ? [{ key: "escape", cmd: () => setComposing(null), desc: "leave", group: "files" }]
          : []),
        ...(editing || !file
          ? []
          : [
              { key: "]", cmd: () => step(1), desc: "next file", group: "files" },
              { key: "[", cmd: () => step(-1), desc: "previous", group: "files" },
              { key: "shift+j", cmd: () => step(1) },
              { key: "shift+k", cmd: () => step(-1) },
              ...(canComment ? [{ key: "c", cmd: comment, desc: "comment", group: "files" }] : []),
              {
                key: "v",
                cmd: () => session.toggleViewed(file.path),
                desc: "viewed",
                group: "files",
              },
              { key: "s", cmd: () => session.setSplit(!split), desc: "split", group: "files" },
              { key: "e", cmd: () => void edit(), desc: "editor", group: "files" },
            ]),
      ],
    }),
    [composing, editing, file, index, files, canComment, split, anchor, session, pull],
  );

  const slot = composing && file ? lineSlot(pull, composing.side, composing.line, file.path) : null;
  // useDraft re-reads its note whenever the object changes: keep it stable per slot.
  const note = useMemo(
    () => (slot ? { id: slot, title: "", value: "", version: composerVersions[slot] ?? 0 } : null),
    [slot, composerVersions],
  );
  const viewedCount = files.filter((f) => session.viewed.has(f.path)).length;
  return (
    <box flexDirection="column" flexGrow={1} gap={1}>
      <box flexDirection="row" flexGrow={1} gap={2}>
        <box
          id="file-tree"
          width={34}
          flexShrink={0}
          flexDirection="column"
          border
          borderColor={color.border}
          paddingX={1}
          title={` files ${viewedCount}/${files.length} viewed `}
        >
          {files.map((f, i) => (
            <box
              key={f.path}
              flexDirection="row"
              height={1}
              backgroundColor={i === index ? color.selected : undefined}
              onMouseDown={() => session.setFile(f.path)}
            >
              <text width={2} fg={session.viewed.has(f.path) ? color.ok : color.faint}>
                {session.viewed.has(f.path) ? "✓" : "·"}
              </text>
              <text
                flexGrow={1}
                wrapMode="none"
                truncate
                fg={i === index ? color.text : color.muted}
              >
                {f.path}
              </text>
              <text wrapMode="none" fg={color.muted}>
                {" "}
                <span fg={color.ok}>+{f.additions}</span>
                <span fg={color.danger}>−{f.deletions}</span>
              </text>
            </box>
          ))}
        </box>
        <box flexDirection="column" flexGrow={1}>
          {file ? (
            <Suspense
              key={file.path}
              fallback={
                <Pulse>
                  <Line id="diff-loading" fg={color.muted}>
                    Streaming {file.path} ({file.additions + file.deletions} changed lines)…
                  </Line>
                  <SkeletonRows count={12} width={80} />
                </Pulse>
              }
            >
              <DiffView
                file={file}
                split={split}
                revision={pull.revision}
                onAnchor={setAnchor}
                active={!editing}
              />
            </Suspense>
          ) : (
            <Line fg={color.muted}>No files in this revision</Line>
          )}
        </box>
      </box>
      {note && composing && file ? (
        <box flexDirection="column" flexShrink={0}>
          <Line fg={color.accent}>
            Comment on {file.path}:{composing.line} ({composing.side === "new" ? "new" : "old"}{" "}
            side)
          </Line>
          <DraftEditor
            id="line-composer"
            note={note}
            editing
            height={3}
            placeholder="Comment on this line (markdown)"
            save={publish}
            resolve={resolveSave}
            onSaved={() => setComposing(null)}
            conflictHint="Composer used elsewhere · Ctrl+X discards"
          />
        </box>
      ) : null}
      <Line id="files-notice" fg={color.warn}>
        {notice}
      </Line>
    </box>
  );
}

function DiffView({
  file,
  split,
  revision,
  onAnchor,
  active,
}: {
  file: ReviewFile;
  split: boolean;
  revision: number;
  onAnchor: (anchor: { side: Side; line: number } | null) => void;
  active: boolean;
}) {
  const diff = use(file.diff);
  const session = useReviewSession();
  const view = useRef<DiffRenderable>(null);
  const scroll = useRef<ScrollBoxRenderable>(null);
  const rows = diff?.rows ?? [];
  const cursor = Math.min(session.cursor(file.path), Math.max(rows.length - 1, 0));
  const row = rows[cursor];

  // The cursor is a highlight on the native renderable, kept in view by scrolling.
  useEffect(() => {
    const target = view.current;
    const box = scroll.current;
    if (!target || split || !row) return;
    target.clearAllLineColors();
    target.highlightLines(cursor, cursor, CURSOR_BG);
    if (box) {
      const height = box.viewport.height;
      if (cursor < box.scrollTop) box.scrollTop = cursor;
      else if (cursor >= box.scrollTop + height) box.scrollTop = cursor - height + 1;
    }
  }, [cursor, row, split]);
  useEffect(() => {
    onAnchor(
      row && !split
        ? row.new !== undefined
          ? { side: "new", line: row.new }
          : { side: "old", line: row.old ?? 0 }
        : null,
    );
  }, [row, split, onAnchor]);

  const move = (delta: number) =>
    session.setCursor(file.path, Math.max(0, Math.min(rows.length - 1, cursor + delta)));
  useBindings(
    () => ({
      bindings:
        !active || !rows.length
          ? []
          : [
              { key: "j", cmd: () => move(1), desc: "line", group: "files" },
              { key: "k", cmd: () => move(-1) },
              { key: "down", cmd: () => move(1) },
              { key: "up", cmd: () => move(-1) },
              { key: "space", cmd: () => move(PAGE_ROWS), desc: "page", group: "files" },
              { key: "pagedown", cmd: () => move(PAGE_ROWS) },
              { key: "pageup", cmd: () => move(-PAGE_ROWS) },
              { key: "g", cmd: () => move(-rows.length) },
              { key: "shift+g", cmd: () => move(rows.length) },
            ],
    }),
    [active, rows.length, cursor, file.path, session],
  );

  if (!diff) return <Line fg={color.warn}>This file is not part of revision {revision}</Line>;
  const here = (c: Comment) =>
    row && ((c.side === "new" && c.line === row.new) || (c.side === "old" && c.line === row.old));
  return (
    <box flexDirection="column" flexGrow={1}>
      <Line id="diff-heading" fg={color.text}>
        {file.path} · {diff.language} · <span fg={color.ok}>+{diff.additions}</span>{" "}
        <span fg={color.danger}>−{diff.deletions}</span> · {split ? "split" : "unified"}
        {session.viewed.has(file.path) ? " · viewed" : ""}
        {row ? ` · line ${row.new ?? row.old}` : ""}
      </Line>
      <scrollbox id="diff-scroll" ref={scroll} flexGrow={1} scrollY>
        <diff
          id="diff"
          ref={view}
          diff={diff.patch}
          view={split ? "split" : "unified"}
          filetype={diff.language}
          syntaxStyle={syntax}
          showLineNumbers
          wrapMode="none"
          addedBg="#12261e"
          removedBg="#2d1215"
          addedSignColor={color.ok}
          removedSignColor={color.danger}
        />
      </scrollbox>
      <box
        id="line-comments"
        height={5}
        flexShrink={0}
        flexDirection="column"
        border={["top"]}
        borderColor={color.border}
      >
        {file.comments.length === 0 ? (
          <Line fg={color.faint}>No line comments</Line>
        ) : (
          file.comments.slice(-COMMENTS_SHOWN).map((c) => (
            <Line key={c.id} fg={here(c) ? color.text : color.muted}>
              {here(c) ? "▶ " : "  "}
              {c.path}:{c.line} @{c.author}: {c.body.replace(/\s+/g, " ")}
              {c.revision < revision ? " (outdated)" : ""}
            </Line>
          ))
        )}
      </box>
    </box>
  );
}
