"use client";
import { useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useDraft, type Note } from "airtty/client";
import {
  merge,
  publish,
  resolveOperation,
  resolveSave,
  review,
  saveDescription,
} from "../actions/pulls";
import { DraftEditor } from "./DraftEditor";
import { useEditing, useEditingWhile } from "./editing";
import { Line } from "./frames";
import type { Comment, Identity, MergeReadiness, PullDetail, Review } from "./model";
import { describe, useOperation } from "./operations";
import { syntax } from "./syntax";
import { ago, checkColor, checkGlyph, color } from "./theme";

type Mode = "read" | "description" | "comment";
type Props = {
  pull: PullDetail;
  me: Identity;
  description: Note;
  composer: Note;
  comments: Comment[];
  reviews: Review[];
  readiness: MergeReadiness;
  now: number;
};

export function Conversation({
  pull,
  me,
  description,
  composer,
  comments,
  reviews,
  readiness,
  now,
}: Props) {
  const [mode, setMode] = useState<Mode>("read");
  const { editing } = useEditing();
  const timeline = useRef<ScrollBoxRenderable>(null);
  useEditingWhile(mode !== "read");
  const descriptionDraft = useDraft(description).draft;
  const composerDraft = useDraft(composer).draft;
  const key = `${pull.repo}#${pull.number}`;
  const verdict = useOperation(`review:${key}`);
  const merging = useOperation(`merge:${key}`);
  const target = { repo: pull.repo, number: pull.number, revision: pull.revision };

  const open = pull.state === "open";
  const canEdit = me.id === pull.author || me.role === "maintainer";
  const canReview = open && me.role !== "reader" && me.id !== pull.author;
  const canMerge = open && me.role === "maintainer";
  const canComment = me.role !== "reader";

  useKeyboard((k) => {
    if (k.name === "escape" && mode !== "read") setMode("read");
    if (k.ctrl && k.name === "o") {
      void verdict.resolve(resolveOperation);
      void merging.resolve(resolveOperation);
    }
    if (k.ctrl && k.name === "x" && mode === "read") {
      verdict.forget();
      merging.forget();
    }
    if (mode !== "read" || (editing && mode === "read") || k.ctrl || k.meta) return;
    if (k.name === "e" && canEdit) setMode("description");
    if (k.name === "c" && canComment) setMode("comment");
    if (k.name === "a" && canReview)
      void verdict.run("Approve", (operationId) =>
        review({ ...target, verdict: "approve", operationId }),
      );
    if (k.name === "x" && canReview)
      void verdict.run("Request changes", (operationId) =>
        review({ ...target, verdict: "changes", operationId }),
      );
    if (k.name === "m" && canMerge)
      void merging.run(`Merge #${pull.number}`, (operationId) => merge({ ...target, operationId }));
    const scroll = timeline.current;
    if (scroll && (k.name === "j" || k.name === "down")) scroll.scrollTop += 2;
    if (scroll && (k.name === "k" || k.name === "up")) scroll.scrollTop -= 2;
  });

  const events = [
    ...comments.map((c) => ({ at: c.createdAt, kind: "comment" as const, comment: c })),
    ...reviews.map((r) => ({ at: r.createdAt, kind: "review" as const, review: r })),
  ].sort((a, b) => a.at - b.at);
  const showDescriptionEditor =
    mode === "description" || descriptionDraft.dirty || descriptionDraft.pending;
  const showComposer = mode === "comment" || composerDraft.dirty || composerDraft.pending;
  const status = describe(merging.state) || describe(verdict.state);

  return (
    <box flexDirection="column" flexGrow={1} gap={1}>
      <box flexDirection="row" flexGrow={1} gap={2}>
        <scrollbox id="timeline" ref={timeline} flexGrow={1} scrollY>
          <box flexDirection="column" gap={1} paddingRight={1}>
            <box
              flexDirection="column"
              border
              borderColor={color.border}
              paddingX={1}
              title={` @${pull.author} · description `}
            >
              {showDescriptionEditor ? (
                <DraftEditor
                  id="description-editor"
                  note={description}
                  editing={mode === "description"}
                  height={6}
                  placeholder="Describe the change"
                  save={saveDescription}
                  resolve={resolveSave}
                  onSaved={() => setMode("read")}
                />
              ) : (
                <markdown
                  id="description"
                  content={description.value}
                  syntaxStyle={syntax}
                  conceal
                />
              )}
            </box>
            {events.map((event) =>
              event.kind === "review" ? (
                <Line
                  key={`r${event.at}${event.review.reviewer}`}
                  fg={event.review.verdict === "approve" ? color.ok : color.danger}
                >
                  {event.review.verdict === "approve" ? "✓" : "✗"} @{event.review.reviewer}{" "}
                  {event.review.verdict === "approve" ? "approved" : "requested changes on"}{" "}
                  revision {event.review.revision} · {ago(event.at, now)}
                  {event.review.revision < pull.revision ? " · stale" : ""}
                </Line>
              ) : (
                <box key={`c${event.comment.id}`} flexDirection="column" flexShrink={0}>
                  <Line fg={color.muted}>
                    <span fg={color.info}>@{event.comment.author}</span>
                    {event.comment.path
                      ? ` on ${event.comment.path}:${event.comment.line}`
                      : ""} ·{" "}
                    {ago(event.at, now)}
                    {event.comment.path && event.comment.revision < pull.revision
                      ? " · outdated"
                      : ""}
                  </Line>
                  <box paddingLeft={2}>
                    <markdown content={event.comment.body} syntaxStyle={syntax} conceal />
                  </box>
                </box>
              ),
            )}
          </box>
        </scrollbox>
        <box
          id="merge-box"
          width={34}
          flexShrink={0}
          flexDirection="column"
          border
          borderColor={color.border}
          paddingX={1}
          title=" merge "
        >
          <Line fg={readiness.canMerge ? color.ok : color.warn}>
            {pull.state === "merged"
              ? `Merged by @${pull.mergedBy}`
              : readiness.canMerge
                ? "Ready to merge"
                : "Not ready"}
          </Line>
          <Line fg={color.muted}>
            Approvals: {readiness.approvals.map((a) => `@${a}`).join(" ") || "none"}
          </Line>
          <Line fg={color.muted}>
            Checks:{" "}
            {readiness.checks.map((s, i) => (
              <span key={i} fg={checkColor[s]}>
                {checkGlyph[s]}{" "}
              </span>
            ))}
          </Line>
          {readiness.reasons.slice(0, 3).map((reason) => (
            <Line key={reason} fg={color.warn}>
              · {reason}
            </Line>
          ))}
          <box flexGrow={1} />
          {canReview ? <Line fg={color.text}>[a] approve [x] changes</Line> : null}
          {canMerge ? (
            <Line fg={readiness.canMerge ? color.accent : color.faint}>[m] merge</Line>
          ) : null}
          {canEdit ? <Line fg={color.text}>[e] edit description</Line> : null}
          {canComment ? <Line fg={color.text}>[c] comment</Line> : null}
        </box>
      </box>
      {showComposer ? (
        <DraftEditor
          id="composer"
          note={composer}
          editing={mode === "comment"}
          height={3}
          placeholder="Leave a comment (markdown)"
          save={publish}
          resolve={resolveSave}
          onSaved={() => setMode("read")}
          conflictHint="Composer used elsewhere · Ctrl+X discards"
        />
      ) : null}
      <Line
        id="operation-status"
        fg={
          merging.state?.status === "unknown" || verdict.state?.status === "unknown"
            ? color.danger
            : color.warn
        }
      >
        {status}
      </Line>
    </box>
  );
}
