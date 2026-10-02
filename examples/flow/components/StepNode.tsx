"use client";
import { Handle, type Node, type NodeProps } from "@luciole-sh/flow-graph";
import { IDLE, STATUS_ICON, type StepKind, type StepRun } from "./model";
import { color, statusColor } from "./theme";

export type StepData = { label: string; command: string; kind: StepKind; run: StepRun };
export type StepNodeType = Node<StepData>;

const WIDTH = 16;
// The border, on both sides.
const FRAME = 2;
const BAR = WIDTH - FRAME;
const MS_PER_SECOND = 1000;

const seconds = (ms: number) => `${(ms / MS_PER_SECOND).toFixed(1)}s`;

/** A pipeline step: its status in the border's color, its progress while it runs. */
export function StepNode({ data, selected, detail, connectTarget }: NodeProps<StepNodeType>) {
  const run = data.run ?? IDLE;
  const tint = statusColor[run.status];
  const border = selected ? color.accent : connectTarget ? color.queued : tint;
  const icon = STATUS_ICON[run.status];
  // Declared, not drawn: the canvas attaches edges there. A source has no input.
  const handles = (
    <>
      {data.kind === "source" ? null : <Handle type="target" position="left" />}
      <Handle type="source" position="right" />
    </>
  );
  if (detail !== "full")
    return (
      <>
        {handles}
        <text
          selectable={false}
          wrapMode="none"
          fg={selected ? color.accent : tint}
          bg={color.panel}
        >
          {` ${icon} ${data.label} `}
        </text>
      </>
    );
  const filled = Math.round(run.progress * BAR);
  const second =
    run.status === "running" ? `${"█".repeat(filled)}${"░".repeat(BAR - filled)}` : data.command;
  return (
    <box
      width={WIDTH}
      border
      borderStyle={data.kind === "deploy" ? "double" : "rounded"}
      borderColor={border}
      backgroundColor={color.panel}
      title={` ${data.label} `}
      flexDirection="column"
    >
      {handles}
      <text selectable={false} wrapMode="none" truncate fg={tint}>
        {icon} {run.status}
        {run.ms > 0 ? <span fg={color.muted}> {seconds(run.ms)}</span> : null}
      </text>
      <text
        selectable={false}
        wrapMode="none"
        truncate
        fg={run.status === "running" ? color.running : color.muted}
      >
        {second}
      </text>
    </box>
  );
}
