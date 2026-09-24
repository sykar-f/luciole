"use client";
import type { ReactNode, Ref } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { Line } from "./Line";
import type { Block } from "./model";
import { color } from "./theme";
import {
  ARG_LINES,
  LIVE_LINES,
  OUTPUT_LINES,
  glyphOf,
  outputLines,
  toolArgs,
  toolStatus,
  toolTitle,
  type Styled,
  type Tool,
} from "./tools";

type Props = {
  blocks: readonly Block[];
  expanded: ReadonlySet<string>;
  selected: string | null;
  now: number;
  onToggle: (id: string) => void;
  scroll: Ref<ScrollBoxRenderable>;
};

// A finished thinking block may be empty: the model reasoned without a summary.
const shown = (block: Block) =>
  block.kind !== "thinking" || block.streaming || block.text.trim() !== "";
/** Foldable blocks: the ones `j`/`k` walk through. */
export const foldable = (block: Block) =>
  shown(block) && (block.kind === "tool" || block.kind === "thinking");
export const blockId = (id: string) => `block-${id}`;

/**
 * The conversation, newest at the bottom. The scrollbox sticks to the bottom while text
 * streams in, until the user scrolls up.
 */
export function Transcript({ blocks, expanded, selected, now, onToggle, scroll }: Props) {
  return (
    <scrollbox
      id="transcript"
      ref={scroll}
      flexGrow={1}
      scrollY
      stickyScroll
      stickyStart="bottom"
      paddingX={1}
    >
      {blocks.length === 0 ? <Empty /> : null}
      {blocks.filter(shown).map((block) => (
        <box key={block.id} id={blockId(block.id)} flexDirection="column" flexShrink={0}>
          <BlockView
            block={block}
            open={expanded.has(block.id)}
            selected={selected === block.id}
            now={now}
            onToggle={() => onToggle(block.id)}
          />
        </box>
      ))}
    </scrollbox>
  );
}

function Empty() {
  return (
    <box flexDirection="column" paddingY={1}>
      <Line fg={color.muted}>No messages yet. Ask something, for instance:</Line>
      <Line fg={color.faint}>
        {" "}
        Create a fizzbuzz.py script, run it for 1 to 15 and show the result.
      </Line>
      <Line fg={color.faint}> List the files here and summarize what each one is for.</Line>
    </box>
  );
}

function BlockView({
  block,
  open,
  selected,
  now,
  onToggle,
}: {
  block: Block;
  open: boolean;
  selected: boolean;
  now: number;
  onToggle: () => void;
}) {
  switch (block.kind) {
    case "user":
      return (
        <box flexDirection="row" marginTop={1} backgroundColor={color.panel} paddingX={1}>
          <text width={2} flexShrink={0} fg={color.accent}>
            ›
          </text>
          <text flexGrow={1} fg={color.text} wrapMode="word">
            {block.text}
          </text>
        </box>
      );
    case "text":
      return (
        <box marginTop={1}>
          <text fg={color.text} wrapMode="word">
            {block.text}
            {block.streaming ? <span fg={color.accent}>▍</span> : null}
          </text>
        </box>
      );
    case "thinking": {
      const first = block.text.trim().split("\n")[0]?.replace(/\*\*/g, "") ?? "";
      return (
        <box flexDirection="column" marginTop={1}>
          <Header selected={selected} onToggle={onToggle}>
            <text flexShrink={0} fg={color.thinking}>
              {open ? "▾" : "▸"} thinking{" "}
            </text>
            <text flexGrow={1} wrapMode="none" truncate fg={color.muted}>
              {block.streaming ? "…" : open ? "" : first}
            </text>
          </Header>
          {open ? (
            <box paddingLeft={2}>
              <text fg={color.muted} wrapMode="word">
                {block.text.trim()}
              </text>
            </box>
          ) : null}
        </box>
      );
    }
    case "tool":
      return (
        <ToolView tool={block} open={open} selected={selected} now={now} onToggle={onToggle} />
      );
    case "notice":
      return (
        <box marginTop={1}>
          <Line fg={block.level === "error" ? color.danger : color.warn}>• {block.text}</Line>
        </box>
      );
  }
}

function Header({
  selected,
  onToggle,
  children,
}: {
  selected: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <box
      flexDirection="row"
      height={1}
      flexShrink={0}
      backgroundColor={selected ? color.selected : undefined}
      onMouseDown={onToggle}
    >
      {children}
    </box>
  );
}

function ToolView({
  tool,
  open,
  selected,
  now,
  onToggle,
}: {
  tool: Tool;
  open: boolean;
  selected: boolean;
  now: number;
  onToggle: () => void;
}) {
  const status = toolStatus(tool, now);
  const output = outputLines(tool);
  const args = open ? toolArgs(tool) : [];
  // Folded, a running call still shows the tail of its output: bash streams.
  const shown = open
    ? output.slice(0, OUTPUT_LINES)
    : tool.status === "running"
      ? output.slice(-LIVE_LINES)
      : [];
  const hidden = open ? output.length - shown.length : 0;
  return (
    <box flexDirection="column" marginTop={1}>
      <Header selected={selected} onToggle={onToggle}>
        <text flexShrink={0} fg={color.faint}>
          {open ? "▾ " : "▸ "}
        </text>
        <text flexShrink={0} fg={color.info}>
          {glyphOf(tool.name)} {tool.name}{" "}
        </text>
        <text flexGrow={1} flexShrink={1} wrapMode="none" truncate fg={color.text}>
          {toolTitle(tool)}
        </text>
        <text flexShrink={0} fg={status.fg}>
          {" "}
          {status.text}
        </text>
      </Header>
      {args.length || shown.length ? (
        <box flexDirection="column" paddingLeft={2} border={["left"]} borderColor={color.border}>
          <Lines lines={args.slice(0, ARG_LINES)} />
          {args.length > ARG_LINES ? (
            <Line fg={color.faint}>… {args.length - ARG_LINES} more lines</Line>
          ) : null}
          {args.length && shown.length ? <Line fg={color.faint}>──</Line> : null}
          <Lines
            lines={shown.map((text) => ({
              text,
              fg: tool.status === "error" ? color.danger : color.muted,
            }))}
          />
          {hidden > 0 || tool.elided > 0 ? (
            <Line fg={color.faint}>
              … {hidden > 0 ? `${hidden} more lines` : ""}
              {tool.elided > 0 ? ` (${tool.elided} characters elided)` : ""}
            </Line>
          ) : null}
        </box>
      ) : null}
    </box>
  );
}

function Lines({ lines }: { lines: readonly Styled[] }) {
  return lines.map((line, i) => (
    <Line key={i} fg={line.fg}>
      {line.text || " "}
    </Line>
  ));
}
