"use client";
import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { useNavigate, type Note } from "@terminal/framework/client";
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
  useKeyboard((key) => {
    if (key.name === "tab") {
      // Tab moves between fields; it must not be typed into the focused one.
      key.preventDefault();
      setField((f) => FIELDS[(FIELDS.indexOf(f) + (key.shift ? 2 : 1)) % FIELDS.length]);
    }
    if (key.name === "escape") setField("branch");
    if (field !== "branch" || key.ctrl) return;
    if (key.name === "down" || key.name === "j")
      setBranch((b) => Math.min(b + 1, branches.length - 1));
    if (key.name === "up" || key.name === "k") setBranch((b) => Math.max(b - 1, 0));
  });
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
        placeholder="Why this change? (markdown) · Ctrl+S opens the pull request"
        save={(snapshot) => openPullRequest(snapshot, title, chosen?.name ?? "")}
        resolve={resolveSave}
        onSaved={opened}
      />
      <Line fg={color.faint}>Tab next field · Esc back to branches · Ctrl+S open pull request</Line>
    </box>
  );
}
