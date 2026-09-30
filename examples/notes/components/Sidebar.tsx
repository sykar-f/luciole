"use client";
import { memo, useState, useSyncExternalStore } from "react";
import { MouseButton, type MouseEvent } from "@opentui/core";
import { useBindings, useParams } from "luciole/client";
import { titleOf, useCommands } from "./commands";
import { drafts, type Note } from "./draft";
import { notesList, useNotesList } from "./notes-list";
import { usePalette, type Palette } from "./theme";
import { Button, Line, useHover } from "./ui";
import { excerptOf, fit, when } from "./format";
import { ui, useUi } from "./ui-state";

const matches = (note: Note, query: string) =>
  `${note.title}\n${note.value}`.toLowerCase().includes(query.toLowerCase());

/** The list of notes on the left: search, then every note, newest first. */
export function Sidebar({ width }: { width: number }) {
  const color = usePalette();
  const { notes, error } = useNotesList();
  const { focus } = useUi();
  const commands = useCommands();
  const { id: selected } = useParams({ strict: false });
  const [query, setQuery] = useState("");
  const [hovered, setHovered] = useState<string | null>(null);
  // Unsaved work is marked in the list, whatever note is on screen.
  useSyncExternalStore(drafts.subscribe, drafts.snapshot);
  const unsaved = new Set(drafts.unsaved().map((d) => d.id));
  const shown = notes?.filter((note) => !query || matches(note, query)) ?? [];
  // Arrows walk the list while nothing is being typed; Return opens the first note.
  const step = (delta: number) => {
    const at = shown.findIndex((note) => note.id === selected);
    const next = shown[at < 0 ? 0 : Math.max(0, Math.min(shown.length - 1, at + delta))];
    if (next && next.id !== selected) commands.open(next.id);
  };
  useBindings(
    () => ({
      bindings:
        focus === null || focus === "search"
          ? [
              { key: "down", cmd: () => step(1) },
              { key: "up", cmd: () => step(-1) },
              ...(selected || focus ? [] : [{ key: "return", cmd: () => step(0) }]),
            ]
          : [],
    }),
    [focus, selected, shown],
  );
  const menuFor = (note: Note, x: number, y: number) =>
    ui.openMenu({
      x,
      y,
      items: [
        { label: "Open", run: () => commands.open(note.id) },
        { label: "Rename…", run: () => commands.rename(note.id) },
        { label: "Delete", danger: true, run: () => void commands.remove(note) },
      ],
    });
  return (
    <box
      id="sidebar"
      width={width}
      flexShrink={0}
      flexDirection="column"
      backgroundColor={color.sidebar}
    >
      <SearchBox
        query={query}
        focused={focus === "search"}
        onQuery={setQuery}
        onOpenFirst={() => {
          const first = shown[0];
          if (first) commands.open(first.id);
        }}
      />
      <scrollbox id="notes" flexGrow={1} scrollY marginTop={1}>
        {notes === null ? (
          <box paddingX={2}>
            <Line fg={color.muted}>{error || "Loading notes…"}</Line>
          </box>
        ) : shown.length === 0 ? (
          <box paddingX={2} flexDirection="column" gap={1}>
            <Line fg={color.muted}>{query ? `No note matches “${query}”` : "No notes yet"}</Line>
            {query ? (
              <Button onPress={() => setQuery("")}>Clear search</Button>
            ) : (
              <Button tone="primary" onPress={() => void commands.create()}>
                + New note
              </Button>
            )}
          </box>
        ) : (
          shown.map((note) => (
            <Row
              key={note.id}
              note={note}
              color={color}
              width={width - ROW_FRAME}
              selected={note.id === selected}
              hovered={note.id === hovered}
              unsaved={unsaved.has(note.id)}
              onHover={(inside) => setHovered((h) => (inside ? note.id : h === note.id ? null : h))}
              onOpen={() => {
                ui.focus(null);
                commands.open(note.id);
              }}
              onMenu={(x, y) => menuFor(note, x, y)}
            />
          ))
        )}
      </scrollbox>
      <box flexDirection="row" height={1} flexShrink={0} paddingX={2} marginBottom={1}>
        <text flexGrow={1} wrapMode="none" truncate fg={error ? color.warn : color.muted}>
          {error && notes
            ? error
            : notes
              ? `${query ? `${shown.length} of ` : ""}${notes.length} note${notes.length === 1 ? "" : "s"}`
              : ""}
        </text>
        {error ? (
          <Button tone="quiet" onPress={() => void notesList.load()}>
            Retry
          </Button>
        ) : null}
      </box>
    </box>
  );
}

function SearchBox({
  query,
  focused,
  onQuery,
  onOpenFirst,
}: {
  query: string;
  focused: boolean;
  onQuery: (query: string) => void;
  onOpenFirst: () => void;
}) {
  const color = usePalette();
  const { hovered, handlers } = useHover();
  return (
    <box
      id="search"
      flexDirection="row"
      height={3}
      flexShrink={0}
      marginX={1}
      paddingLeft={1}
      border
      borderStyle="rounded"
      borderColor={focused ? color.accent : hovered ? color.muted : color.border}
      backgroundColor={focused || hovered ? color.buttonHover : color.button}
      {...handlers}
      onMouseDown={(event: MouseEvent) => {
        event.stopPropagation();
        ui.focus("search");
      }}
    >
      <text width={2} flexShrink={0} fg={focused ? color.accent : color.muted}>
        {"⌕"}
      </text>
      <input
        id="search-field"
        flexGrow={1}
        focused={focused}
        value={query}
        onInput={onQuery}
        onSubmit={() => {
          ui.focus(null);
          onOpenFirst();
        }}
        placeholder="Search"
        backgroundColor="transparent"
        focusedBackgroundColor="transparent"
        textColor={color.text}
        focusedTextColor={color.text}
        placeholderColor={color.muted}
      />
      {query ? (
        <Button
          tone="quiet"
          onPress={() => {
            onQuery("");
            ui.focus(null);
          }}
        >
          ✕
        </Button>
      ) : null}
    </box>
  );
}

/** A row's margin, border and padding, both sides. */
const ROW_FRAME = 6;
/** The "⋯" button beside a title. */
const MENU_BUTTON = 3;
const Row = memo(function Row({
  note,
  color,
  width,
  selected,
  hovered,
  unsaved,
  onHover,
  onOpen,
  onMenu,
}: {
  note: Note;
  color: Palette;
  width: number;
  selected: boolean;
  hovered: boolean;
  unsaved: boolean;
  onHover: (inside: boolean) => void;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const date = when(note.updated);
  const marker = unsaved ? "● " : "";
  const dated = `${marker}${date ? `${date}  ` : ""}`;
  return (
    <box
      id={`note-row-${note.id}`}
      flexDirection="column"
      flexShrink={0}
      height={4}
      marginX={1}
      paddingX={1}
      border
      borderStyle="rounded"
      borderColor={selected ? color.accent : hovered ? color.muted : color.border}
      backgroundColor={selected ? color.selected : hovered ? color.hover : undefined}
      onMouseOver={() => onHover(true)}
      onMouseOut={() => onHover(false)}
      onMouseDown={(event: MouseEvent) => {
        if (event.button === MouseButton.RIGHT) onMenu(event.x, event.y);
        else if (event.button === MouseButton.LEFT) onOpen();
      }}
    >
      <box flexDirection="row" height={1} flexShrink={0}>
        <text flexGrow={1} wrapMode="none" fg={selected ? color.accent : color.text}>
          <strong>{fit(titleOf(note), width - MENU_BUTTON)}</strong>
        </text>
        {hovered || selected ? (
          <box
            id={`note-menu-${note.id}`}
            flexShrink={0}
            paddingX={1}
            backgroundColor={hovered ? color.buttonHover : undefined}
            onMouseDown={(event: MouseEvent) => {
              event.stopPropagation();
              onMenu(event.x, event.y + 1);
            }}
          >
            <text fg={color.muted}>⋯</text>
          </box>
        ) : null}
      </box>
      <text height={1} flexShrink={0} wrapMode="none" fg={color.muted}>
        <span fg={color.accent}>{marker}</span>
        {dated.slice(marker.length)}
        <span fg={selected ? color.text : color.muted}>
          {fit(excerptOf(note.value), width - dated.length)}
        </span>
      </text>
    </box>
  );
});
