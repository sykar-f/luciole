"use client";
import { memo, type ReactNode, type Ref } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { Markdown } from "luciole/client";
import { Line } from "./Line";
import type { FilePatch, Item, ItemStatus } from "../model";
import { languageOf, muted, syntax } from "./syntax";
import { color } from "./theme";

// Folded, a running command still shows the end of its output.
export const LIVE_LINES = 12;
// Unfolded, output beyond this is summarised: the transcript is no log viewer.
const OUTPUT_LINES = 200;
const SECOND_MS = 1000;
const MINUTE_S = 60;
const DECIMALS_UNDER = 10;

/** Items `j`/`k` walk through: the ones that fold. */
export const foldable = (item: Item) =>
  item.kind === "reasoning" ||
  item.kind === "command" ||
  item.kind === "file_change" ||
  item.kind === "tool" ||
  (item.kind === "subagent" && item.detail !== "");
/** Open unless the user folded it: diffs are what one reads; outputs are noise. */
export const openByDefault = (item: Item) => item.kind === "file_change";
export const itemId = (id: string) => `item-${id}`;
export const running = (item: Item) => "status" in item && item.status === "running";

const duration = (item: Item, now: number) => {
  if (item.startedAt === undefined) return "";
  const seconds = ((item.endedAt ?? now) - item.startedAt) / SECOND_MS;
  if (seconds < 0) return "";
  if (seconds >= MINUTE_S)
    return `${Math.floor(seconds / MINUTE_S)}m${Math.round(seconds % MINUTE_S)}s`;
  return `${seconds.toFixed(seconds < DECIMALS_UNDER ? 1 : 0)} s`;
};
const statusColor: Record<ItemStatus, string> = {
  running: color.warn,
  done: color.ok,
  error: color.danger,
  declined: color.muted,
};
const statusGlyph: Record<ItemStatus, string> = {
  running: "●",
  done: "✓",
  error: "✗",
  declined: "⊘",
};

type Props = {
  items: readonly Item[];
  isOpen: (item: Item) => boolean;
  selected: string | null;
  now: number;
  wide: boolean;
  sticky: boolean;
  onToggle: (id: string) => void;
  /** A link clicked in a reply or a thought. */
  onLink: (url: string) => void;
  /** The project's directory: where relative image paths in replies start from. */
  cwd: string;
  scroll: Ref<ScrollBoxRenderable>;
  empty: ReactNode;
};

/**
 * The conversation, newest at the bottom. The scrollbox follows new output while
 * `sticky`; the screen turns that off when the reader scrolls up (OpenTUI #1514: a fold
 * would otherwise pull the reader back to the bottom).
 */
export function Transcript({
  items,
  isOpen,
  selected,
  now,
  wide,
  sticky,
  onToggle,
  onLink,
  cwd,
  scroll,
  empty,
}: Props) {
  return (
    <scrollbox
      id="transcript"
      ref={scroll}
      flexGrow={1}
      scrollY
      stickyScroll={sticky}
      stickyStart="bottom"
      paddingX={1}
    >
      {items.length === 0 ? empty : null}
      {items.map((item) => (
        <box key={item.id} id={itemId(item.id)} flexDirection="column" flexShrink={0}>
          <ItemView
            item={item}
            open={isOpen(item)}
            selected={selected === item.id}
            // Only running items tick: finished ones are drawn once.
            now={running(item) ? now : 0}
            wide={wide}
            onToggle={onToggle}
            onLink={onLink}
            cwd={cwd}
          />
        </box>
      ))}
    </scrollbox>
  );
}

type ItemProps = {
  item: Item;
  open: boolean;
  selected: boolean;
  now: number;
  wide: boolean;
  onToggle: (id: string) => void;
  onLink: (url: string) => void;
  cwd: string;
};

/** One item; finished items keep their identity across updates and are not redrawn. */
const ItemView = memo(function ItemView({
  item,
  open,
  selected,
  now,
  wide,
  onToggle,
  onLink,
  cwd,
}: ItemProps) {
  const toggle = () => onToggle(item.id);
  switch (item.kind) {
    case "user":
      return (
        <box flexDirection="row" marginTop={1} backgroundColor={color.panel} paddingX={1}>
          <text width={2} flexShrink={0} fg={color.user}>
            ›
          </text>
          <text flexGrow={1} fg={color.text} wrapMode="word">
            {item.text}
          </text>
        </box>
      );
    case "message":
      return (
        <box marginTop={1}>
          <Markdown
            content={item.text}
            streaming={item.streaming}
            syntaxStyle={syntax}
            onLink={onLink}
            imageBase={cwd}
          />
        </box>
      );
    case "reasoning": {
      const first = item.text.trim().split("\n")[0]?.replace(/\*\*/g, "") ?? "";
      return (
        <box flexDirection="column" marginTop={1}>
          <Header selected={selected} onToggle={toggle}>
            <text flexShrink={0} fg={color.thinking}>
              {open ? "▾" : "▸"} thinking{item.streaming ? "…" : ""}{" "}
            </text>
            <text flexGrow={1} wrapMode="none" truncate fg={color.faint}>
              {open ? "" : first}
            </text>
          </Header>
          {open ? (
            <box paddingLeft={2}>
              <Markdown
                content={item.text.trim()}
                streaming={item.streaming}
                syntaxStyle={muted}
                onLink={onLink}
                imageBase={cwd}
              />
            </box>
          ) : null}
        </box>
      );
    }
    case "command": {
      const lines = item.output
        .replace(/\n$/, "")
        .split("\n")
        .filter((l, i, all) => l || i < all.length - 1);
      const shown = open
        ? lines.slice(-OUTPUT_LINES)
        : item.status === "running"
          ? lines.slice(-LIVE_LINES)
          : [];
      const hidden = open ? lines.length - shown.length : 0;
      const exit =
        item.status === "running"
          ? `running ${duration(item, now)}`
          : item.exitCode !== undefined
            ? `exit ${item.exitCode} · ${duration(item, now)}`
            : duration(item, now);
      return (
        <box flexDirection="column" marginTop={1}>
          <Header selected={selected} onToggle={toggle}>
            <text flexShrink={0} fg={color.faint}>
              {open ? "▾ " : "▸ "}
            </text>
            <text flexShrink={0} fg={color.info}>
              ${" "}
            </text>
            <text flexGrow={1} flexShrink={1} wrapMode="none" truncate fg={color.text}>
              {item.command.split("\n")[0]}
            </text>
            <text flexShrink={0} fg={statusColor[item.status]}>
              {" "}
              {statusGlyph[item.status]} {exit}
            </text>
          </Header>
          {shown.length ? (
            <box
              flexDirection="column"
              paddingLeft={2}
              border={["left"]}
              borderColor={color.border}
            >
              {hidden > 0 ? <Line fg={color.faint}>… {hidden} earlier lines</Line> : null}
              {shown.map((text, i) => (
                <Line key={i} fg={item.status === "error" ? color.danger : color.muted}>
                  {text || " "}
                </Line>
              ))}
            </box>
          ) : null}
        </box>
      );
    }
    case "file_change":
      return (
        <box flexDirection="column" marginTop={1}>
          {item.files.map((file, i) => (
            <FileView
              key={file.path}
              file={file}
              status={item.status}
              open={open}
              selected={selected && i === 0}
              wide={wide}
              onToggle={toggle}
            />
          ))}
        </box>
      );
    case "tool": {
      const output = item.output.trim();
      return (
        <box flexDirection="column" marginTop={1}>
          <Header selected={selected} onToggle={toggle}>
            <text flexShrink={0} fg={color.faint}>
              {open ? "▾ " : "▸ "}
            </text>
            <text flexShrink={0} fg={color.info}>
              ⚙ {item.name}{" "}
            </text>
            <text flexGrow={1} flexShrink={1} wrapMode="none" truncate fg={color.text}>
              {item.title}
            </text>
            <text flexShrink={0} fg={statusColor[item.status]}>
              {" "}
              {statusGlyph[item.status]} {duration(item, now)}
            </text>
          </Header>
          {open ? (
            <box
              flexDirection="column"
              paddingLeft={2}
              border={["left"]}
              borderColor={color.border}
            >
              {item.input ? (
                <text fg={color.muted} wrapMode="char">
                  {item.input}
                </text>
              ) : null}
              {output ? (
                <text fg={item.status === "error" ? color.danger : color.text} wrapMode="char">
                  {output.split("\n").slice(0, OUTPUT_LINES).join("\n")}
                </text>
              ) : null}
            </box>
          ) : null}
        </box>
      );
    }
    case "subagent":
      return (
        <box flexDirection="column" marginTop={1}>
          <Header selected={selected} onToggle={toggle}>
            <text flexShrink={0} fg={color.thinking}>
              ◇ Task{" "}
            </text>
            <text flexGrow={1} flexShrink={1} wrapMode="none" truncate fg={color.text}>
              « {item.title} » · {item.tools} tool{item.tools === 1 ? "" : "s"}
            </text>
            <text flexShrink={0} fg={statusColor[item.status]}>
              {" "}
              {item.status === "running"
                ? `running ${duration(item, now)}`
                : `${statusGlyph[item.status]} ${duration(item, now)}`}
            </text>
          </Header>
          {open && item.detail ? (
            <box paddingLeft={2}>
              <text fg={color.muted} wrapMode="word">
                {item.detail}
              </text>
            </box>
          ) : null}
        </box>
      );
    case "compaction":
      return (
        <box marginTop={1}>
          <Line fg={color.muted}>
            ◇ {item.status === "running" ? "compacting the context…" : "context compacted"}
          </Line>
        </box>
      );
    case "notice":
      return (
        <box marginTop={1}>
          <text
            fg={
              item.level === "error"
                ? color.danger
                : item.level === "warn"
                  ? color.warn
                  : color.muted
            }
            wrapMode="word"
          >
            • {item.text}
          </text>
        </box>
      );
  }
});

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

function FileView({
  file,
  status,
  open,
  selected,
  wide,
  onToggle,
}: {
  file: FilePatch;
  status: ItemStatus;
  open: boolean;
  selected: boolean;
  wide: boolean;
  onToggle: () => void;
}) {
  return (
    <box flexDirection="column" flexShrink={0}>
      <Header selected={selected} onToggle={onToggle}>
        <text flexShrink={0} fg={color.faint}>
          {open ? "▾ " : "▸ "}
        </text>
        <text flexShrink={0} fg={statusColor[status]}>
          ✎{" "}
        </text>
        <text
          flexGrow={1}
          flexShrink={1}
          wrapMode="none"
          truncate
          fg={status === "declined" ? color.muted : color.text}
        >
          {file.path}
          {status === "declined" ? " (declined)" : ""}
        </text>
        <text flexShrink={0}>
          <span fg={color.ok}> +{file.additions}</span>
          <span fg={color.danger}> −{file.deletions}</span>
        </text>
      </Header>
      {open ? <Patch patch={file.patch} path={file.path} wide={wide} /> : null}
    </box>
  );
}

/** One file's unified patch; split into two columns on wide terminals. */
export function Patch({ patch, path, wide }: { patch: string; path: string; wide: boolean }) {
  return (
    <box paddingLeft={2} flexShrink={0}>
      <diff
        diff={patch}
        view={wide ? "split" : "unified"}
        filetype={languageOf(path)}
        syntaxStyle={syntax}
        showLineNumbers
        wrapMode="none"
        addedBg={color.addedBg}
        removedBg={color.removedBg}
        addedSignColor={color.ok}
        removedSignColor={color.danger}
      />
    </box>
  );
}
