"use client";
import { useState } from "react";
import { useField, useForm } from "@tanstack/react-form";
import { Input, Textarea, useBindings, useNavigate, useRestoredFields } from "airtty/client";
import { openPullRequest, resolveSave } from "../actions/pulls";
import type { Note } from "./draft";
import { useEditingWhile } from "./editing";
import { Line } from "./frames";
import type { OperationResult, PublishResult } from "./model";
import { describe, useOperation } from "./operations";
import { color } from "./theme";

type Field = "branch" | "title" | "description";
const FIELDS: Field[] = ["branch", "title", "description"];
// The Server checks the same limits (server/forge.ts): checking first saves a request.
const MIN_TITLE = 3,
  MAX_BODY = 4000,
  DESCRIPTION_ROWS = 6;

/** A publication seen as an operation: its outcome can be unknown and looked up. */
const asOperation = (result: PublishResult): OperationResult =>
  result.ok
    ? { ok: true, operationId: result.operationId, message: "Pull request opened" }
    : { ok: false, operationId: result.operationId, error: result.error };

// A form, not a document: TanStack Form holds the values and validates them. The title
// and description are named fields, restored after a crash or a rebuild; the request
// goes through `useOperation`, so a lost answer is looked up in the ledger, never replayed.
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
  const fields = useRestoredFields("new-pull");
  const opening = useOperation(`new-pull:${repo}`);
  const [field, setField] = useState<Field>("branch");
  useEditingWhile(field !== "branch");
  /** A committed pull request opens its page; the result becomes an operation's. */
  const opened = (result: PublishResult) => {
    if (result.ok && result.number)
      void navigate({
        to: "/repos/$repo/pulls/$number",
        params: { repo, number: String(result.number) },
      });
    return asOperation(result);
  };
  const form = useForm({
    defaultValues: { branch: branches[0]?.name ?? "", title: "", description: "" },
    onSubmit: ({ value }) =>
      opening.run("Open pull request", async (operationId) =>
        opened(
          // Forgets the kept text while the request runs; a refusal keeps it again.
          await fields.submit(
            () =>
              openPullRequest(
                {
                  id: composer.id,
                  value: value.description,
                  version: composer.version,
                  revision: 0,
                  operationId,
                },
                value.title.trim(),
                value.branch,
              ),
            { failed: (result) => !result.ok },
          ),
        ),
      ),
  });
  // Hooks rather than `<form.Field>`: OpenTUI's JSX namespace declares no `ElementType`,
  // so TypeScript refuses a component typed to return `ReactNode | Promise<ReactNode>`.
  const branch = useField({ form, name: "branch" });
  const title = useField({
    form,
    name: "title",
    validators: {
      onSubmit: ({ value }) =>
        value.trim().length < MIN_TITLE
          ? `Title needs at least ${MIN_TITLE} characters`
          : undefined,
    },
  });
  const description = useField({
    form,
    name: "description",
    validators: {
      onSubmit: ({ value }) =>
        !value.trim() || value.length > MAX_BODY ? `Enter 1–${MAX_BODY} characters` : undefined,
    },
  });
  const cycle = (delta: number) =>
    setField((f) => FIELDS[(FIELDS.indexOf(f) + delta + FIELDS.length) % FIELDS.length]);
  const pick = (delta: number) => {
    const at = branches.findIndex((b) => b.name === form.getFieldValue("branch"));
    const next = branches[Math.max(0, Math.min(at + delta, branches.length - 1))];
    if (next) form.setFieldValue("branch", next.name);
  };
  const unknown = opening.state?.status === "unknown" || opening.state?.status === "unresolved";
  // Tab moves between fields: the binding keeps it out of the focused one.
  useBindings(
    () => ({
      bindings: [
        { key: "tab", cmd: () => cycle(1), desc: "next field", group: "form" },
        { key: "shift+tab", cmd: () => cycle(-1) },
        {
          key: "ctrl+s",
          cmd: () => void form.handleSubmit(),
          desc: "open pull request",
          group: "form",
        },
        ...(unknown
          ? [
              {
                key: "ctrl+o",
                cmd: () =>
                  void opening.resolve(async (operationId) => {
                    const result = await resolveSave(operationId);
                    return result && opened(result);
                  }),
                desc: "resolve",
                group: "form",
              },
            ]
          : []),
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
    [field, branches, unknown],
  );
  const errors = (field: { state: { meta: { errors: unknown[] } } }) =>
    field.state.meta.errors.length ? (
      <Line fg={color.warn}>{field.state.meta.errors.map(String).join(" · ")}</Line>
    ) : null;
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
        {branches.map((b) => {
          const chosen = b.name === branch.state.value;
          return (
            <Line
              key={b.name}
              fg={chosen ? color.text : color.muted}
              bg={chosen ? color.selected : undefined}
            >
              {chosen ? "▶ " : "  "}
              {b.name} · @{b.author} · {b.files} file(s)
            </Line>
          );
        })}
      </box>
      <box flexDirection="column" flexShrink={0}>
        <box flexDirection="row" gap={1} height={1}>
          <Line fg={field === "title" ? color.accent : color.muted}>Title</Line>
          <Input
            id="new-pull-title"
            name="new-pull/title"
            focused={field === "title"}
            value={title.state.value}
            onInput={title.handleChange}
            placeholder="Short summary"
            flexGrow={1}
          />
        </box>
        {errors(title)}
      </box>
      <box flexDirection="column" flexShrink={0}>
        <box
          border
          borderColor={field === "description" ? color.accent : color.border}
          height={DESCRIPTION_ROWS + 2}
          flexShrink={0}
        >
          <Textarea
            id="new-pull-description"
            name="new-pull/description"
            focused={field === "description"}
            value={description.state.value}
            onChange={description.handleChange}
            placeholder="Why this change? (markdown)"
            textColor={color.text}
            focusedTextColor={color.text}
          />
        </box>
        {errors(description)}
      </box>
      <Line id="new-pull-status" fg={unknown ? color.danger : color.muted}>
        {describe(opening.state) || "Unsaved form · restored after a crash"}
      </Line>
    </box>
  );
}
