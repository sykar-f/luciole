"use client";
import { useState } from "react";
import { Input, useBindings } from "luciole/client";
import { Overlay } from "./Dialogs";
import { Line } from "./Line";
import { color } from "./theme";

export type PickerItem = {
  id: string;
  label: string;
  detail?: string;
  /** Why it cannot be picked: shown, never chosen. */
  blocked?: string;
  current?: boolean;
};
// Rows shown at once; the filter narrows the rest.
const VISIBLE = 12;
const FOOTER_ROWS = 2;

/** An overlay list with a filter: models, efforts, modes, sessions, commands. */
export function Picker({
  title,
  items,
  loading,
  error,
  onPick,
  onClose,
}: {
  title: string;
  items: readonly PickerItem[];
  loading?: boolean;
  error?: string;
  onPick: (item: PickerItem) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(() =>
    Math.max(
      0,
      items.findIndex((i) => i.current),
    ),
  );
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? items.filter((i) => `${i.label} ${i.detail ?? ""} ${i.id}`.toLowerCase().includes(needle))
    : items;
  const at = Math.min(cursor, Math.max(0, shown.length - 1));
  const move = (delta: number) => setCursor(Math.max(0, Math.min(shown.length - 1, at + delta)));
  const pick = () => {
    const item = shown[at];
    if (item && !item.blocked) onPick(item);
  };
  useBindings(
    () => ({
      bindings: [
        { key: "down", cmd: () => move(1), desc: "move", group: "picker" },
        { key: "up", cmd: () => move(-1) },
        { key: "ctrl+n", cmd: () => move(1) },
        { key: "ctrl+p", cmd: () => move(-1) },
        { key: "return", cmd: pick, desc: "choose", group: "picker" },
        { key: "escape", cmd: onClose, desc: "close", group: "picker" },
      ],
    }),
    [at, shown.length, onClose, onPick],
  );
  const start = Math.max(0, Math.min(at - Math.floor(VISIBLE / 2), shown.length - VISIBLE));
  return (
    <Overlay
      title={title}
      // The filter, a blank row, the list (or one line saying why it is empty), the footer.
      rows={2 + Math.max(1, Math.min(VISIBLE, shown.length)) + FOOTER_ROWS}
      footer={<Line fg={color.muted}>Type to filter · ↑↓ move · Enter choose · Esc close</Line>}
    >
      <box height={1} flexDirection="row" flexShrink={0}>
        <text flexShrink={0} fg={color.accent}>
          ›{" "}
        </text>
        <Input
          focused
          value={filter}
          onInput={(text) => {
            setFilter(text);
            setCursor(0);
          }}
          textColor={color.text}
          flexGrow={1}
        />
      </box>
      <box flexDirection="column" paddingTop={1} flexShrink={1}>
        {loading ? <Line fg={color.muted}>Loading…</Line> : null}
        {error ? <Line fg={color.danger}>{error}</Line> : null}
        {!loading && !error && !shown.length ? <Line fg={color.muted}>Nothing matches</Line> : null}
        {shown.slice(start, start + VISIBLE).map((item, i) => (
          <box
            key={item.id}
            flexDirection="row"
            height={1}
            backgroundColor={start + i === at ? color.selected : undefined}
            onMouseDown={() => {
              setCursor(start + i);
              if (!item.blocked) onPick(item);
            }}
          >
            <text flexShrink={0} fg={item.current ? color.accent : color.faint}>
              {item.current ? "● " : "  "}
            </text>
            <text flexShrink={0} fg={item.blocked ? color.faint : color.text}>
              {item.label}
            </text>
            <text
              flexGrow={1}
              wrapMode="none"
              truncate
              fg={item.blocked ? color.warn : color.muted}
            >
              {item.blocked ? `  ${item.blocked}` : item.detail ? `  ${item.detail}` : ""}
            </text>
          </box>
        ))}
      </box>
    </Overlay>
  );
}
