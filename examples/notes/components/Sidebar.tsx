"use client";
import { memo, useState, useSyncExternalStore } from "react";
import { MouseButton, type MouseEvent } from "@opentui/core";
import { useBindings, useParams } from "@luciole-sh/core/client";
import { titleOf, useCommands } from "./commands";
import { drafts, type Note } from "./draft";
import { notesList, useNotesList } from "./notes-list";
import { usePalette, type Palette } from "./theme";
import {
  BlockButton,
  Button,
  ICON_BUTTON_HEIGHT,
  ICON_BUTTON_WIDTH,
  IconButton,
  Line,
  useHover,
} from "./ui";
import { excerptOf, fit, whenShort } from "./format";
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
  // Dates padded to the widest shown, so every preview starts in the same column.
  const dateWidth = Math.max(0, ...shown.map((note) => whenShort(note.updated).length));
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
  return (
    <box
      id="sidebar"
      width={width}
      flexShrink={0}
      flexDirection="column"
      backgroundColor={color.sidebar}
    >
      {/* ≡ search +, one bar from edge to edge, on the buttons' own grey: the controls line
          up with the notes below, the bar with the sidebar. The ≡ belongs to the window,
          which draws it over the room left here, so that it stays put while the list
          slides (app/layout.tsx). */}
      <box
        id="sidebar-bar"
        flexDirection="row"
        height={ICON_BUTTON_HEIGHT}
        flexShrink={0}
        paddingX={1}
        backgroundColor={color.button}
      >
        <box width={ICON_BUTTON_WIDTH} flexShrink={0} />
        <SearchBox
          query={query}
          focused={focus === "search"}
          onQuery={setQuery}
          onOpenFirst={() => {
            const first = shown[0];
            if (first) commands.open(first.id);
          }}
        />
        <NewNoteButton />
      </box>
      {/* Its scrollbar as the note's: a faint thumb on the list's own background. */}
      <scrollbox
        id="notes"
        flexGrow={1}
        scrollY
        marginTop={1}
        verticalScrollbarOptions={{
          trackOptions: { foregroundColor: color.faint, backgroundColor: color.sidebar },
        }}
      >
        {notes === null ? (
          <box paddingX={2}>
            <Line fg={color.muted}>{error || "Loading notes…"}</Line>
          </box>
        ) : shown.length === 0 ? (
          <box paddingX={2} flexDirection="column" alignItems="flex-start" gap={1}>
            <Line fg={color.muted}>{query ? `No note matches “${query}”` : "No notes yet"}</Line>
            {query ? (
              <Button onPress={() => setQuery("")}>Clear search</Button>
            ) : (
              <BlockButton tone="primary" filled onPress={() => void commands.create()}>
                + New note
              </BlockButton>
            )}
          </box>
        ) : (
          shown.map((note) => (
            <Row
              key={note.id}
              note={note}
              color={color}
              width={width - ROW_FRAME}
              dateWidth={dateWidth}
              selected={note.id === selected}
              hovered={note.id === hovered}
              unsaved={unsaved.has(note.id)}
              onHover={(inside) => setHovered((h) => (inside ? note.id : h === note.id ? null : h))}
              onOpen={() => {
                ui.focus(null);
                commands.open(note.id);
              }}
              onMenu={(x, y) => commands.menu(note, x, y)}
            />
          ))
        )}
      </scrollbox>
      {/* Below the list, never over it: a rule marks where the list is cut. */}
      <box
        flexDirection="row"
        height={2}
        flexShrink={0}
        marginX={1}
        paddingX={1}
        marginBottom={1}
        border={["top"]}
        borderColor={color.border}
      >
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

/** "+", beside the search while the list is open, under the ≡ while it is folded. */
export function NewNoteButton() {
  const commands = useCommands();
  return (
    <IconButton id="new-note" icon="+" tone="primary" onPress={() => void commands.create()} />
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
      flexGrow={1}
      flexShrink={1}
      height={ICON_BUTTON_HEIGHT}
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

/** A row's margin, border and padding, both sides, and the list's scrollbar. */
const ROW_FRAME = 7;
/** The "⋯" button beside a title. */
const MENU_BUTTON = 3;
const Row = memo(function Row({
  note,
  color,
  width,
  dateWidth,
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
  dateWidth: number;
  selected: boolean;
  hovered: boolean;
  unsaved: boolean;
  onHover: (inside: boolean) => void;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const date = whenShort(note.updated);
  const marker = unsaved ? "● " : "";
  const dated = `${marker}${dateWidth ? `${date.padEnd(dateWidth)}  ` : ""}`;
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
          <strong>{fit(titleOf(note), hovered || selected ? width - MENU_BUTTON : width)}</strong>
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
