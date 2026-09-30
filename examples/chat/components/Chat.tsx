"use client";
import { useRef, useState } from "react";
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { KeyHelp, Textarea, useBindings, useRestoredFields } from "luciole/client";
import { chats, streamingIn, totals, useChats, type Conversation } from "./conversations";
import { ChatFrame, Line } from "./frames";
import type { Setup } from "./model";
import { ReplyStream } from "./ReplyStream";
import { Transcript } from "./Transcript";
import { color, perMillion, tokens, usd } from "./theme";

const SIDEBAR = 30;
const WIDE = 100;
// The composer grows with its text up to this many lines, then scrolls.
const COMPOSER_MAX_LINES = 6;
// Root padding, the gap next to the sidebar and the composer border.
const CHROME_COLUMNS = 4;

// Enter sends; a new line needs Alt+Enter, or Ctrl+J where Alt is taken by the terminal
// (Shift+Enter too, on terminals that report it).
const COMPOSER_KEYS = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "return", meta: true, action: "newline" },
  { name: "return", shift: true, action: "newline" },
  { name: "linefeed", action: "newline" },
] as const;

export function Chat({ setup }: { setup: Setup }) {
  const { conversations } = useChats();
  const conversation = chats.active();
  const { width } = useTerminalDimensions();
  const [text, setText] = useState("");
  // Enter can arrive in the same read as the keys before it (fast typing, a paste), before
  // the field reports its change: the submit reads the field itself, not the last render.
  const field = useRef<TextareaRenderable>(null);
  const fields = useRestoredFields("chat");
  // Why the last Enter sent nothing, for the text it was pressed on: typing hides it. (The
  // field reports its content after the submit, so clearing on change would erase it.)
  const [refusal, setRefusal] = useState<{ reason: string; text: string }>();
  const transcript = useRef<ScrollBoxRenderable>(null);
  const streaming = streamingIn(conversation);
  const last = conversation.messages.at(-1);
  const retryable =
    last?.role === "assistant" && (last.status === "error" || last.status === "stopped");
  const blocked = setup.configError
    ? `${setup.configError} on the Server`
    : setup.keyMissing
      ? "OPENROUTER_API_KEY is not set on the Server: export it and restart"
      : undefined;

  const notice = refusal?.text === text ? refusal.reason : undefined;
  const toBottom = () => transcript.current?.scrollTo(transcript.current.scrollHeight);
  function send() {
    const prompt = (field.current?.plainText ?? text).trim();
    if (!prompt) return;
    const refuse = (reason: string) =>
      setRefusal({ reason, text: field.current?.plainText ?? text });
    if (blocked) return refuse(blocked);
    if (!chats.send(prompt)) return refuse("A reply is still streaming · Esc stops it");
    // Empty the field itself: its pending change events then report "", not the sent text.
    field.current?.setText("");
    setText("");
    setRefusal(undefined);
    // Sent: a crash from here on must not offer this text again.
    fields.clear();
    toBottom();
  }
  const scroll = (pages: number) => transcript.current?.scrollBy(pages, "viewport");

  useBindings(
    () => ({
      bindings: [
        ...(streaming
          ? [
              {
                key: "escape",
                cmd: () => chats.stop(conversation.id, streaming.id),
                desc: "stop",
                group: "chat",
              },
            ]
          : []),
        ...(retryable && !blocked
          ? [
              {
                key: "ctrl+g",
                cmd: () => {
                  chats.retry();
                  toBottom();
                },
                desc: "retry",
                group: "chat",
              },
            ]
          : []),
        {
          key: "ctrl+n",
          cmd: () => {
            chats.create();
            setRefusal(undefined);
          },
          desc: "new chat",
          group: "chat",
        },
        ...(conversations.length > 1
          ? [
              { key: "ctrl+up", cmd: () => chats.select(-1), desc: "newer", group: "chat" },
              { key: "ctrl+down", cmd: () => chats.select(1), desc: "older", group: "chat" },
            ]
          : []),
        { key: "pageup", cmd: () => scroll(-1), desc: "scroll", group: "chat" },
        { key: "pagedown", cmd: () => scroll(1) },
      ],
    }),
    [streaming, retryable, blocked, conversation.id, conversations.length],
  );

  const sidebar = width >= WIDE;
  const columns = Math.max(
    1,
    width - CHROME_COLUMNS - (sidebar ? SIDEBAR + CHROME_COLUMNS / 2 : 0),
  );
  const lines = text
    .split("\n")
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / columns)), 0);
  const composerHeight = Math.min(COMPOSER_MAX_LINES, lines);
  // Every reply that is streaming keeps its stream, whatever conversation is shown.
  const live = conversations.flatMap((c) => {
    const reply = streamingIn(c);
    return reply ? [{ conversationId: c.id, reply }] : [];
  });

  return (
    <box flexDirection="row" flexGrow={1} gap={2}>
      {sidebar ? <Sidebar conversations={conversations} activeId={conversation.id} /> : null}
      <ChatFrame
        header={<Header setup={setup} conversation={conversation} />}
        composer={
          <>
            <box
              id="composer"
              border
              borderColor={blocked ? color.warn : streaming ? color.border : color.accent}
              height={composerHeight + 2}
              flexShrink={0}
              title={streaming ? " waiting for the reply… " : " message "}
            >
              <Textarea
                ref={field}
                name="chat/prompt"
                focused
                value={text}
                onChange={setText}
                onSubmit={send}
                keyBindings={[...COMPOSER_KEYS]}
                placeholder={blocked ? "Set OPENROUTER_API_KEY to chat" : "Message the model"}
                textColor={color.text}
                focusedTextColor={color.text}
              />
            </box>
            <Line id="composer-status" fg={notice ? color.warn : color.faint}>
              {notice ?? "Enter send · Alt+Enter / Ctrl+J new line"}
            </Line>
            <box id="chat-help" height={1} flexShrink={0}>
              <KeyHelp inline groups={["chat"]} fg={color.muted} accent={color.accent} />
            </box>
          </>
        }
      >
        <Transcript
          key={conversation.id}
          conversation={conversation}
          setup={setup}
          ref={transcript}
        />
      </ChatFrame>
      {live.map(({ conversationId, reply }) => (
        <ReplyStream key={reply.id} conversationId={conversationId} message={reply} />
      ))}
    </box>
  );
}

function Header({ setup, conversation }: { setup: Setup; conversation: Conversation }) {
  const spent = totals(conversation);
  return (
    <box flexDirection="row" flexGrow={1} gap={2}>
      <text height={1} flexGrow={1} flexShrink={1} wrapMode="none" truncate fg={color.muted}>
        <span fg={color.accent}>{setup.model}</span>
        {setup.pricing
          ? ` · ${perMillion(setup.pricing.prompt)} in · ${perMillion(setup.pricing.completion)} out`
          : ""}
        {` · ${setup.endpoint}`}
      </text>
      <text id="chat-totals" height={1} flexShrink={0} wrapMode="none" fg={color.muted}>
        {spent.tokens ? `${tokens(spent.tokens)} tokens` : ""}
        {spent.cost !== undefined ? ` · ${spent.estimated ? "≈" : ""}${usd(spent.cost)}` : ""}
      </text>
    </box>
  );
}

function Sidebar({ conversations, activeId }: { conversations: Conversation[]; activeId: number }) {
  return (
    <box
      id="sidebar"
      width={SIDEBAR}
      flexShrink={0}
      flexDirection="column"
      border
      borderColor={color.border}
      paddingX={1}
      title=" conversations "
    >
      {conversations.map((c) => {
        const turns = c.messages.filter((m) => m.role === "user").length;
        const spent = totals(c);
        const busy = streamingIn(c);
        return (
          <box
            key={c.id}
            flexDirection="column"
            flexShrink={0}
            backgroundColor={c.id === activeId ? color.selected : undefined}
            onMouseDown={() => chats.selectId(c.id)}
          >
            <Line fg={c.id === activeId ? color.accent : color.text}>
              {busy ? "◐ " : ""}
              {c.title}
            </Line>
            <Line fg={color.faint}>
              {turns ? `${turns} turn${turns > 1 ? "s" : ""}` : "empty"}
              {spent.cost !== undefined ? ` · ${usd(spent.cost)}` : ""}
            </Line>
          </box>
        );
      })}
    </box>
  );
}
