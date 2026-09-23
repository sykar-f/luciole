"use client";
import { Suspense, use, useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { DiffRenderable, ScrollBoxRenderable } from "@opentui/core";
import { publish, resolveSave } from "../actions/pulls";
import { drafts } from "./draft";
import { DraftEditor } from "./DraftEditor";
import { useEditing, useEditingWhile } from "./editing";
import { Line, SkeletonRows } from "./frames";
import type { Comment, FileDiff, FileSummary, PullDetail, Side } from "./model";
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

  useKeyboard((key) => {
    if (key.name === "escape" && composing) setComposing(null);
    if (editing || key.ctrl || key.meta || !file) return;
    if (key.sequence === "]" || key.sequence === "J")
      session.setFile(files[Math.min(index + 1, files.length - 1)].path);
    if (key.sequence === "[" || key.sequence === "K")
      session.setFile(files[Math.max(index - 1, 0)].path);
    if (key.name === "v") session.toggleViewed(file.path);
    if (key.name === "s") session.setSplit(!split);
    if (key.name === "c" && canComment) {
      if (split) setNotice("Switch to unified view (s) to comment on a line");
      else if (!anchor) setNotice("Move the cursor to a diff line first (j/k)");
      else if (drafts.unsaved().length >= drafts.capacity)
        setNotice(`Draft limit reached (${drafts.capacity}): publish or discard a Draft first`);
      else {
        setNotice("");
        setComposing(anchor);
      }
    }
  });

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

  useKeyboard((key) => {
    if (!active || key.ctrl || !rows.length) return;
    const move = (delta: number) =>
      session.setCursor(file.path, Math.max(0, Math.min(rows.length - 1, cursor + delta)));
    if (key.name === "j" || key.name === "down") move(1);
    if (key.name === "k" || key.name === "up") move(-1);
    if (key.name === "pagedown" || key.name === "space") move(PAGE_ROWS);
    if (key.name === "pageup") move(-PAGE_ROWS);
    if (key.name === "g") move(-rows.length);
    if (key.sequence === "G") move(rows.length);
  });

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
          <Line fg={color.faint}>
            No line comments · j/k move · c comment · v viewed · s split · [ ] file
          </Line>
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
