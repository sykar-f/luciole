"use client";
import { useEffect, useState, type Ref } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { Assistant, Conversation } from "./conversations";
import { Line } from "./frames";
import type { Setup } from "./model";
import { syntax } from "./syntax";
import { color, perMillion, seconds, tokens, usd } from "./theme";

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const SPINNER_MS = 90;
// While the model reasons, its last characters show as a faint single line.
const REASONING_TAIL = 160;

function useSpinner(active: boolean) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), SPINNER_MS);
    return () => clearInterval(timer);
  }, [active]);
  return SPINNER[frame];
}

export function Transcript({
  conversation,
  setup,
  ref,
}: {
  conversation: Conversation;
  setup: Setup;
  ref: Ref<ScrollBoxRenderable>;
}) {
  if (!conversation.messages.length) return <Welcome setup={setup} />;
  return (
    <scrollbox
      id="transcript"
      ref={ref}
      flexGrow={1}
      scrollY
      stickyScroll
      stickyStart="bottom"
      contentOptions={{ flexDirection: "column", gap: 1, paddingRight: 1 }}
    >
      {conversation.messages.map((m) =>
        m.role === "user" ? (
          <box key={m.id} flexDirection="column" flexShrink={0}>
            <Line fg={color.user}>› you</Line>
            <box paddingLeft={2}>
              <text fg={color.text}>{m.content}</text>
            </box>
          </box>
        ) : (
          <Reply key={m.id} message={m} fallbackModel={setup.model} />
        ),
      )}
    </scrollbox>
  );
}

function Reply({ message, fallbackModel }: { message: Assistant; fallbackModel: string }) {
  const streaming = message.status === "streaming";
  const spinner = useSpinner(streaming);
  const model = message.model ?? fallbackModel;
  const usage = message.usage;
  const stats = [
    usage
      ? `${tokens(usage.promptTokens)} in · ${tokens(usage.completionTokens)} out` +
        (usage.reasoningTokens ? ` (${tokens(usage.reasoningTokens)} reasoning)` : "")
      : undefined,
    usage?.cost !== undefined ? `${usage.estimated ? "≈" : ""}${usd(usage.cost)}` : undefined,
    message.elapsedMs !== undefined ? seconds(message.elapsedMs) : undefined,
  ].filter(Boolean);
  const reasoningOnly = streaming && !message.content && message.reasoning;
  return (
    <box flexDirection="column" flexShrink={0}>
      <Line fg={color.accent}>
        {streaming ? spinner : "‹"} {model.split("/").at(-1)}
        <span fg={color.faint}>{stats.length ? `  ${stats.join(" · ")}` : ""}</span>
        {streaming ? (
          <span fg={color.warn}>{message.content ? "  streaming…" : "  thinking…"}</span>
        ) : null}
        {message.status === "stopped" ? (
          <span fg={color.warn}>{"  stopped · Ctrl+G retry"}</span>
        ) : null}
      </Line>
      <box paddingLeft={2} flexDirection="column">
        {reasoningOnly ? (
          <Line fg={color.faint}>
            {message.reasoning.slice(-REASONING_TAIL).replaceAll("\n", " ")}
          </Line>
        ) : null}
        {message.content ? (
          <markdown content={message.content} syntaxStyle={syntax} conceal streaming={streaming} />
        ) : null}
        {message.error ? (
          <text fg={color.danger}>
            ✗ {message.error}
            <span fg={color.warn}>{" · Ctrl+G retry"}</span>
          </text>
        ) : null}
      </box>
    </box>
  );
}

function Welcome({ setup }: { setup: Setup }) {
  const price = setup.pricing
    ? `${perMillion(setup.pricing.prompt)} in · ${perMillion(setup.pricing.completion)} out`
    : "price unknown";
  return (
    <box id="welcome" flexDirection="column" flexGrow={1} gap={1} paddingTop={1}>
      {setup.keyMissing || setup.configError ? (
        <box
          id="setup-warning"
          flexDirection="column"
          flexShrink={0}
          border
          borderColor={color.warn}
          paddingX={1}
          title=" setup "
        >
          {setup.configError ? (
            <text fg={color.warn}>{setup.configError} on the Server.</text>
          ) : (
            <text fg={color.warn}>OPENROUTER_API_KEY is not set on the Server.</text>
          )}
          <text fg={color.text}>
            Create a key at https://openrouter.ai/keys, then restart with it:
          </text>
          <text fg={color.accent}>
            {"  "}OPENROUTER_API_KEY=sk-or-… bun packages/luciole/src/cli.ts dev --app examples/chat
          </text>
          <text fg={color.muted}>
            The key stays on the Server: the terminal Client never receives it.
          </text>
        </box>
      ) : null}
      <box flexDirection="column" flexShrink={0}>
        <Line fg={color.text}>Ask anything. Replies stream token by token.</Line>
        <Line fg={color.muted}>
          {setup.modelName ?? setup.model} · {price}
          {setup.contextLength ? ` · ${tokens(setup.contextLength)} context` : ""}
        </Line>
        <Line fg={color.muted}>
          Enter sends · Alt+Enter or Ctrl+J adds a line · Esc stops a reply
        </Line>
      </box>
    </box>
  );
}
