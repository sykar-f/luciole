"use client";
import { useState } from "react";
import { useBindings, useNavigate } from "airtty/client";
import type { Note } from "./draft";
import { openPullRequest, resolveSave } from "../actions/pulls";
import { DraftEditor } from "./DraftEditor";
import { useEditingWhile } from "./editing";
import { Line } from "./frames";
import type { PublishResult } from "./model";
import { color } from "./theme";

type Field = "branch" | "title" | "description";
const FIELDS: Field[] = ["branch", "title", "description"];

// The description is a Draft (it survives navigation); title and branch are plain local
// state: a Draft holds one string, so the form keeps the rest itself.
export function NewPullForm({
  repo,
  branches,
  composer,
}: {
  repo: string;
  branches: { name: string; author: string; files: number }[];
  composer: Note;
}) {
  const navigate = useNavigate();
  const [field, setField] = useState<Field>("branch");
  const [branch, setBranch] = useState(0);
  const [title, setTitle] = useState("");
  useEditingWhile(field !== "branch");
  const cycle = (delta: number) =>
    setField((f) => FIELDS[(FIELDS.indexOf(f) + delta + FIELDS.length) % FIELDS.length]);
  const pick = (delta: number) =>
    setBranch((b) => Math.max(0, Math.min(b + delta, branches.length - 1)));
  // Tab moves between fields: the binding keeps it out of the focused one.
  useBindings(
    () => ({
      bindings: [
        { key: "tab", cmd: () => cycle(1), desc: "next field", group: "form" },
        { key: "shift+tab", cmd: () => cycle(-1) },
        ...(field === "branch"
          ? [
              { key: "j", cmd: () => pick(1), desc: "down", group: "form" },
              { key: "k", cmd: () => pick(-1), desc: "up", group: "form" },
              { key: "down", cmd: () => pick(1) },
              { key: "up", cmd: () => pick(-1) },
            ]
          : [{ key: "escape", cmd: () => setField("branch"), desc: "branches", group: "form" }]),
      ],
    }),
    [field, branches.length],
  );
  const chosen = branches[branch];
  const opened = (result: PublishResult) => {
    if (result.ok && result.number)
      void navigate({
        to: "/repos/$repo/pulls/$number",
        params: { repo, number: String(result.number) },
      });
  };
  return (
    <box flexDirection="column" flexGrow={1} gap={1}>
      <box
        flexDirection="column"
        flexShrink={0}
        border
        borderColor={field === "branch" ? color.accent : color.border}
        paddingX={1}
        title=" branch "
      >
        {branches.length === 0 ? (
          <Line fg={color.muted}>Every branch already has a pull request</Line>
        ) : null}
        {branches.map((b, i) => (
          <Line
            key={b.name}
            fg={i === branch ? color.text : color.muted}
            bg={i === branch ? color.selected : undefined}
          >
            {i === branch ? "▶ " : "  "}
            {b.name} · @{b.author} · {b.files} file(s)
          </Line>
        ))}
      </box>
      <box flexDirection="row" gap={1} height={1} flexShrink={0}>
        <Line fg={field === "title" ? color.accent : color.muted}>Title</Line>
        <input
          id="new-pull-title"
          focused={field === "title"}
          value={title}
          onInput={setTitle}
          placeholder="Short summary"
          flexGrow={1}
        />
      </box>
      <DraftEditor
        id="new-pull-description"
        note={composer}
        editing={field === "description"}
        height={6}
        placeholder="Why this change? (markdown)"
        save={(snapshot) => openPullRequest(snapshot, title, chosen?.name ?? "")}
        resolve={resolveSave}
        onSaved={opened}
        saveLabel="open pull request"
      />
    </box>
  );
}
