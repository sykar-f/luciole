import { useContext, useEffect, useId } from "react";
import { labelOf } from "./geometry";
import { NodeIdContext, useStore } from "./hooks";
import { useFlowTheme } from "./theme";
import type { HandleType, NodeComponent, NodeProps, Position } from "./types";

/**
 * Declares where a node's edges attach: a node component renders one per handle. It
 * draws nothing itself: the canvas marks handles on the node's border when useful (the
 * selected node's sources, every target while connecting). Handles sharing a side are
 * spread along it, in the order they are rendered.
 */
export function Handle({
  type,
  position,
  id = null,
}: {
  type: HandleType;
  position: Position;
  id?: string | null;
}) {
  const nodeId = useContext(NodeIdContext);
  const store = useStore();
  const key = useId();
  useEffect(() => {
    if (!nodeId) return;
    store.addHandle(nodeId, key, { id, type, position });
    return () => store.removeHandle(nodeId, key);
  }, [store, nodeId, key, id, type, position]);
  return null;
}

/** A label in a rounded box, one row tall; its label only when compact. */
export function DefaultNode({ data, id, selected, detail, connectTarget, type }: NodeProps) {
  const theme = useFlowTheme();
  const label = labelOf({ id, data, position: { x: 0, y: 0 } });
  const color = selected ? theme.selected : connectTarget ? theme.connect : theme.border;
  if (detail === "compact")
    return (
      <text
        selectable={false}
        fg={selected || connectTarget ? color : theme.text}
        bg={theme.panelBg}
      >
        {` ${label} `}
      </text>
    );
  // An input starts the flow and an output ends it: their border says so.
  return (
    <box
      border
      borderStyle={type === "input" ? "double" : type === "output" ? "heavy" : "rounded"}
      borderColor={color}
      paddingX={1}
      backgroundColor={theme.panelBg}
    >
      <text selectable={false} fg={theme.text} wrapMode="none">
        {label}
      </text>
    </box>
  );
}

/** A frame other nodes sit in (`parentId`), sized by the node's `width` and `height`. */
export function GroupNode({ data, id, selected, detail, width, height }: NodeProps) {
  const theme = useFlowTheme();
  const label = labelOf({ id, data, position: { x: 0, y: 0 } });
  return (
    <box
      width={width}
      height={height}
      border
      borderStyle="single"
      borderColor={selected ? theme.selected : theme.group}
      title={detail === "full" ? ` ${label} ` : undefined}
    />
  );
}

export const builtinNodeTypes: Record<string, NodeComponent> = {
  default: DefaultNode,
  input: DefaultNode,
  output: DefaultNode,
  group: GroupNode,
};
