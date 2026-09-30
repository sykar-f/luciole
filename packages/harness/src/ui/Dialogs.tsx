"use client";
import { useState, type ReactNode } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { Input, useBindings } from "luciole/client";
import { Line } from "./Line";
import type { Decision, Request, Response } from "../model";
import { syntax } from "./syntax";
import { color } from "./theme";
import { Patch } from "./Transcript";

// The dialog leaves this many rows and columns of the screen around it.
const MARGIN_ROWS = 4;
const MARGIN_COLUMNS = 8;
const MAX_WIDTH = 120;
const MAX_OPTIONS = 9;
const MIN_WIDTH = 20;
const MIN_HEIGHT = 6;
const BORDER_ROWS = 2;
// A footer: its top border, a message, the keys.
const FOOTER_ROWS = 3;
const lineCount = (text: string) => text.split("\n").length;
// The rows `<diff>` draws: headers and hunk markers are not drawn.
const drawnRows = (patch: string) =>
  patch
    .trimEnd()
    .split("\n")
    .filter((line) => !/^(---|\+\+\+|@@)/.test(line)).length;

const DECISION_KEYS: Record<Decision, { key: string; label: string; fg: string }> = {
  once: { key: "y", label: "allow once", fg: color.ok },
  session: { key: "s", label: "allow for this session", fg: color.ok },
  always: { key: "a", label: "always allow", fg: color.info },
  deny: { key: "n", label: "deny", fg: color.danger },
};

/** A box over the whole screen, positioned against the frame's root (OpenTUI #1512). */
export function Overlay({
  title,
  children,
  footer,
  rows,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Rows its content and footer need: the box grows to that, up to the screen. */
  rows?: number;
}) {
  const { width, height } = useTerminalDimensions();
  const boxWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width - MARGIN_COLUMNS));
  return (
    <box
      id="overlay"
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      zIndex={100}
      justifyContent="center"
      alignItems="center"
    >
      <box
        id="overlay-box"
        width={boxWidth}
        maxHeight={Math.max(MIN_HEIGHT, height - MARGIN_ROWS)}
        {...(rows === undefined
          ? {}
          : { height: Math.min(rows + BORDER_ROWS, Math.max(MIN_HEIGHT, height - MARGIN_ROWS)) })}
        flexDirection="column"
        border
        borderStyle="rounded"
        borderColor={color.accent}
        backgroundColor={color.overlay}
        title={` ${title} `}
        paddingX={1}
      >
        {children}
        {footer ? (
          <box flexShrink={0} flexDirection="column" border={["top"]} borderColor={color.border}>
            {footer}
          </box>
        ) : null}
      </box>
    </box>
  );
}

export type DialogProps = {
  request: Request;
  wide: boolean;
  /** Why the last answer did not go through, or that its outcome is being checked. */
  message?: { text: string; fg: string };
  onRespond: (response: Response) => void;
  /** Esc: deny and interrupt the turn. */
  onCancel: () => void;
};

/** What the agent waits for; it takes the keyboard until answered. */
export function RequestDialog(props: DialogProps) {
  switch (props.request.kind) {
    case "approval":
      return <ApprovalDialog {...props} request={props.request} />;
    case "question":
      return <QuestionDialog {...props} request={props.request} />;
    case "plan_review":
      return <PlanDialog {...props} request={props.request} />;
  }
}

function Message({ message }: { message?: DialogProps["message"] }) {
  return message ? <Line fg={message.fg}>{message.text}</Line> : null;
}

function ApprovalDialog({
  request,
  wide,
  message,
  onRespond,
  onCancel,
}: DialogProps & { request: Request & { kind: "approval" } }) {
  useBindings(
    () => ({
      bindings: [
        ...request.decisions.map((decision) => ({
          key: DECISION_KEYS[decision].key,
          cmd: () => onRespond({ kind: "approval", decision }),
          desc: DECISION_KEYS[decision].label,
          group: "dialog",
        })),
        { key: "escape", cmd: onCancel, desc: "deny and stop", group: "dialog" },
      ],
    }),
    [request.id, onRespond, onCancel],
  );
  // Each file: its header and patch lines; a command: its lines and padding.
  const rows =
    (request.detail ? lineCount(request.detail) : 0) +
    (request.command ? lineCount(request.command) + 2 : 0) +
    (request.files ?? []).reduce((sum, f) => sum + 1 + drawnRows(f.patch), 0) +
    FOOTER_ROWS;
  return (
    <Overlay
      title={request.title}
      rows={rows}
      footer={
        <>
          <Message message={message} />
          <text height={1} wrapMode="none" truncate>
            {request.decisions.map((decision, i) => (
              <span key={decision}>
                {i ? "   " : ""}
                <span fg={DECISION_KEYS[decision].fg}>{DECISION_KEYS[decision].key}</span>{" "}
                <span fg={color.muted}>{DECISION_KEYS[decision].label}</span>
              </span>
            ))}
            <span fg={color.muted}> Esc deny and stop</span>
          </text>
        </>
      }
    >
      <scrollbox id="approval" flexGrow={1} flexShrink={1} scrollY>
        {request.detail ? (
          <text fg={color.muted} wrapMode="word">
            {request.detail}
          </text>
        ) : null}
        {request.command ? (
          <box flexShrink={0} paddingY={1} backgroundColor={color.panel}>
            <code content={request.command} filetype="bash" syntaxStyle={syntax} drawUnstyledText />
          </box>
        ) : null}
        {request.files?.map((file) => (
          <box key={file.path} flexDirection="column" flexShrink={0}>
            <Line fg={color.text}>
              ✎ {file.path} <span fg={color.ok}>+{file.additions}</span>{" "}
              <span fg={color.danger}>−{file.deletions}</span>
            </Line>
            <Patch patch={file.patch} path={file.path} wide={wide} />
          </box>
        ))}
      </scrollbox>
    </Overlay>
  );
}

function QuestionDialog({
  request,
  message,
  onRespond,
  onCancel,
}: DialogProps & { request: Request & { kind: "question" } }) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<readonly (readonly string[])[]>([]);
  const [cursor, setCursor] = useState(0);
  const [chosen, setChosen] = useState<ReadonlySet<number>>(new Set());
  const question = request.questions[index];
  const options = question?.options.slice(0, MAX_OPTIONS) ?? [];
  const answer = (labels: readonly string[]) => {
    const all = [...answers, labels];
    setChosen(new Set());
    setCursor(0);
    if (all.length >= request.questions.length) onRespond({ kind: "question", answers: all });
    else {
      setAnswers(all);
      setIndex(index + 1);
    }
  };
  const pick = (at: number) => {
    const option = options[at];
    if (!option) return;
    if (!question?.multiple) return answer([option.label]);
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(at)) next.delete(at);
      else next.add(at);
      return next;
    });
  };
  const confirm = () =>
    question?.multiple
      ? answer(options.filter((_, i) => chosen.has(i)).map((o) => o.label))
      : pick(cursor);
  useBindings(
    () => ({
      bindings: [
        ...options.map((_, i) => ({
          key: String(i + 1),
          cmd: () => pick(i),
          ...(i === 0 ? { desc: `choose 1–${options.length}`, group: "dialog" } : {}),
        })),
        { key: "down", cmd: () => setCursor((c) => Math.min(options.length - 1, c + 1)) },
        { key: "j", cmd: () => setCursor((c) => Math.min(options.length - 1, c + 1)) },
        { key: "up", cmd: () => setCursor((c) => Math.max(0, c - 1)) },
        { key: "k", cmd: () => setCursor((c) => Math.max(0, c - 1)) },
        ...(question?.multiple
          ? [{ key: "space", cmd: () => pick(cursor), desc: "toggle", group: "dialog" }]
          : []),
        { key: "return", cmd: confirm, desc: "confirm", group: "dialog" },
        { key: "escape", cmd: onCancel, desc: "dismiss and stop", group: "dialog" },
      ],
    }),
    [request.id, index, cursor, chosen, options.length, onCancel],
  );
  if (!question) return null;
  return (
    <Overlay
      title={question.header ?? "Question"}
      rows={lineCount(question.question) + 1 + options.length + FOOTER_ROWS}
      footer={
        <>
          <Message message={message} />
          <Line fg={color.muted}>
            {request.questions.length > 1
              ? `Question ${index + 1}/${request.questions.length} · `
              : ""}
            {question.multiple ? "Space toggles, Enter confirms" : "A digit or Enter chooses"} · Esc
            dismisses
          </Line>
        </>
      }
    >
      <text fg={color.text} wrapMode="word">
        {question.question}
      </text>
      <box flexDirection="column" paddingTop={1}>
        {options.map((option, i) => (
          <box
            key={option.label}
            flexDirection="row"
            height={1}
            backgroundColor={i === cursor ? color.selected : undefined}
            onMouseDown={() => {
              setCursor(i);
              pick(i);
            }}
          >
            <text flexShrink={0} fg={color.accent}>
              {question.multiple ? (chosen.has(i) ? "[x] " : "[ ] ") : ""}
              {i + 1}.{" "}
            </text>
            <text flexShrink={0} fg={color.text}>
              {option.label}
            </text>
            <text flexGrow={1} wrapMode="none" truncate fg={color.muted}>
              {option.description ? `  ${option.description}` : ""}
            </text>
          </box>
        ))}
      </box>
    </Overlay>
  );
}

function PlanDialog({
  request,
  message,
  onRespond,
  onCancel,
}: DialogProps & { request: Request & { kind: "plan_review" } }) {
  const [feedback, setFeedback] = useState<string | null>(null);
  const writing = feedback !== null;
  useBindings(
    () => ({
      bindings: writing
        ? [{ key: "escape", cmd: () => setFeedback(null), desc: "back", group: "dialog" }]
        : [
            {
              key: "y",
              cmd: () => onRespond({ kind: "plan_review", approve: true }),
              desc: "approve",
              group: "dialog",
            },
            {
              key: "n",
              cmd: () => onRespond({ kind: "plan_review", approve: false }),
              desc: "keep planning",
              group: "dialog",
            },
            { key: "f", cmd: () => setFeedback(""), desc: "feedback", group: "dialog" },
            { key: "escape", cmd: onCancel, desc: "dismiss and stop", group: "dialog" },
          ],
    }),
    [request.id, writing, onRespond, onCancel],
  );
  return (
    <Overlay
      title="Review the plan"
      rows={lineCount(request.plan) + FOOTER_ROWS}
      footer={
        <>
          <Message message={message} />
          {writing ? (
            <box height={1} flexDirection="row">
              <text flexShrink={0} fg={color.accent}>
                feedback ›{" "}
              </text>
              <Input
                name="coder/plan-feedback"
                focused
                value={feedback}
                onInput={setFeedback}
                onSubmit={() =>
                  onRespond({
                    kind: "plan_review",
                    approve: false,
                    feedback: feedback.trim() || undefined,
                  })
                }
                textColor={color.text}
                flexGrow={1}
              />
            </box>
          ) : (
            <Line fg={color.muted}>
              y approve · n keep planning · f give feedback · Esc dismiss
            </Line>
          )}
        </>
      }
    >
      <scrollbox id="plan-review" flexGrow={1} flexShrink={1} scrollY>
        <markdown content={request.plan} conceal syntaxStyle={syntax} />
      </scrollbox>
    </Overlay>
  );
}
