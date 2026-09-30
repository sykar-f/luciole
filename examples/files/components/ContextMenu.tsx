"use client";
import { useState } from "react";
import type { MouseEvent } from "@opentui/core";
import { useBindings } from "luciole/client";
import { color } from "./theme";

export type MenuItem = { label: string; hint?: string; run: () => void } | "separator";

// Label and hint are separated by at least this many cells; the frame adds two per side.
const GAP = 3,
  FRAME = 4,
  MIN_WIDTH = 24;

/** The menu's size in cells, so that its opener can keep it inside the screen. */
export function menuSize(items: readonly MenuItem[]) {
  const width = Math.max(
    MIN_WIDTH,
    ...items.map((i) => (i === "separator" ? 0 : i.label.length + (i.hint?.length ?? 0) + GAP)),
  );
  return { width: width + FRAME, height: items.length + 2 };
}

/**
 * A floating menu over its parent box, at `left`/`top` in the parent's cells. It owns
 * the keyboard while open (arrows or j/k, Enter, Esc); a click outside closes it.
 */
export function ContextMenu({
  items,
  left,
  top,
  onClose,
}: {
  items: readonly MenuItem[];
  left: number;
  top: number;
  onClose: () => void;
}) {
  const actionable = items.flatMap((item, i) => (item === "separator" ? [] : [i]));
  const [active, setActive] = useState(actionable[0] ?? 0);
  const { width } = menuSize(items);

  const step = (delta: number) => {
    const at = actionable.indexOf(active);
    setActive(actionable[(at + delta + actionable.length) % actionable.length]);
  };
  const run = (index: number) => {
    const item = items[index];
    if (item === undefined || item === "separator") return;
    onClose();
    item.run();
  };
  useBindings(
    () => ({
      bindings: [
        { key: "down", cmd: () => step(1) },
        { key: "j", cmd: () => step(1) },
        { key: "up", cmd: () => step(-1) },
        { key: "k", cmd: () => step(-1) },
        { key: "return", cmd: () => run(active), desc: "choose", group: "files" },
        { key: "escape", cmd: onClose, desc: "close menu", group: "files" },
      ],
    }),
    [active, items, onClose],
  );

  return (
    <>
      {/* Catches every click outside the menu, of any button. */}
      <box
        position="absolute"
        left={0}
        top={0}
        width="100%"
        height="100%"
        zIndex={10}
        onMouseDown={onClose}
      />
      <box
        id="context-menu"
        position="absolute"
        left={left}
        top={top}
        zIndex={11}
        width={width}
        flexDirection="column"
        border
        borderStyle="rounded"
        borderColor={color.accent}
        backgroundColor={color.panel}
      >
        {items.map((item, i) =>
          item === "separator" ? (
            <text key={i} height={1} fg={color.border} wrapMode="none">
              {"─".repeat(width - 2)}
            </text>
          ) : (
            <box
              key={i}
              flexDirection="row"
              height={1}
              paddingX={1}
              backgroundColor={i === active ? color.selected : undefined}
              onMouseOver={() => setActive(i)}
              onMouseDown={(event: MouseEvent) => {
                event.stopPropagation();
                run(i);
              }}
            >
              <text flexGrow={1} wrapMode="none" fg={i === active ? color.accent : color.text}>
                {item.label}
              </text>
              <text wrapMode="none" fg={color.muted}>
                {item.hint ?? ""}
              </text>
            </box>
          ),
        )}
      </box>
    </>
  );
}
