"use client";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { decodePasteBytes } from "@opentui/core";
import { usePaste, useTerminalDimensions } from "@opentui/react";
import {
  KeyHelp,
  TransportError,
  useApplication,
  useBindings,
  useCanGoBack,
  useNavigate,
  useRouter,
} from "airtty/client";
import { receiveDropped, uploadDropped } from "../actions/drop";
import { preview as fetchPreview } from "../actions/files";
import { type Dropped, inspectDrop, readDropped } from "./drop";
import { ago, date, permissions, size, typeOf } from "./format";
import { Line, SkeletonRows } from "./frames";
import {
  COPY_MAX_BYTES,
  type Entry,
  type Listing,
  type Preview,
  type ReceiveResult,
} from "./model";
import { next, prefsStore, SORTS, usePrefs } from "./prefs";
import { imageTarget, PreviewPane } from "./Preview";
import { Pulse } from "./Pulse";
import { color, glyphOf } from "./theme";

// Selection waits this long before asking for a preview (holding j stays local), and the
// pane keeps the previous preview for a moment before showing a loading state.
const PREVIEW_DELAY_MS = 60,
  LOADING_AFTER_MS = 150,
  PRELOAD_DELAY_MS = 150,
  NEIGHBOUR_DELAY_MS = 250;
const IMAGE_NAME = /\.(png|jpe?g|gif|webp)$/i;
// Previews already seen come back at once; images over this size are fetched again.
const CACHE_ENTRIES = 32,
  CACHE_IMAGE_BYTES = 2_097_152; // 2 MiB
// The list column takes a share of the width, within bounds; narrower terminals only
// show the preview when zoomed.
const LIST_SHARE = 0.38,
  LIST_MIN = 30,
  LIST_MAX = 56,
  PREVIEW_MIN_WIDTH = 80,
  PAGE_ROWS = 10,
  DETAILS_ROWS = 6,
  // Below this terminal height the details panel folds into one line.
  DETAILS_MIN_HEIGHT = 32,
  SIZE_WIDTH = 8;

// Last selected name per directory: going back up lands on the directory you came from.
const remembered = new Map<string, string>();
const cache = new Map<string, Preview>();
const cacheKey = (e: Entry) => `${e.path}\0${e.modified}\0${e.size}`;
function keep(key: string, preview: Preview) {
  if (preview.kind === "image" && preview.thumbnail.data.byteLength > CACHE_IMAGE_BYTES) return;
  cache.delete(key);
  cache.set(key, preview);
  for (const oldest of cache.keys()) {
    if (cache.size <= CACHE_ENTRIES) break;
    cache.delete(oldest);
  }
}

const opensAsDirectory = (e: Entry) =>
  e.kind === "directory" || (e.kind === "symlink" && e.targetKind === "directory");
const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");
const searchOf = (path: string) => (path ? { dir: path } : {});
const bytes = new Intl.NumberFormat("en-US");

function sorted<T extends Entry>(entries: T[], sort: string): T[] {
  if (sort === "size") return [...entries].sort((a, b) => b.size - a.size);
  if (sort === "modified") return [...entries].sort((a, b) => b.modified - a.modified);
  return entries;
}

type Loaded = { path: string; preview: Preview } | { path: string; error: string };
// A dropped file shows in the list at once, as a ghost row at its sorted place, until the
// Server's listing has it (or the transfer fails and the ghost goes away).
type Arrival = { name: string; size: number; at: number; state: "arriving" | "copying" | "done" };
type ListRow = Entry & { arriving?: Arrival["state"] };
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
// The list keeps its focus border this long after the last arrival lands.
const LANDED_MS = 900;

const REFUSED: Record<Extract<ReceiveResult, { ok: false }>["reason"], string> = {
  exists: "a file with this name is already here",
  "not-local": "not on the Server's machine",
  "read-only": "the Server is read-only (FILES_READ_ONLY=1)",
  invalid: "invalid name or directory",
  "too-large": `larger than ${size(COPY_MAX_BYTES)}, too large to copy`,
};

/**
 * Selection, filtering, sorting, hidden files and zoom are local: they never reach the
 * Server. Opening a directory is a navigation (history, loading screen, Esc cancels);
 * selecting an entry asks the Server for its preview, cancelled when the selection moves.
 */
export function Explorer({ listing }: { listing: Listing }) {
  const app = useApplication();
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const { width, height } = useTerminalDimensions();
  const prefs = usePrefs();
  const [filtering, setFiltering] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedName, setSelectedName] = useState(() => remembered.get(listing.path));
  const [hovered, setHovered] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const [help, setHelp] = useState(false);
  // A notice belongs to the entry it is about: moving the selection hides it.
  const [notice, setNotice] = useState<{ about: string; text: string } | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // The path whose preview has been awaited long enough to show a loading state.
  const [slowPath, setSlowPath] = useState<string | null>(null);
  // Files dropped on the terminal, then the outcome of their transfer.
  const [arrivals, setArrivals] = useState<Arrival[]>([]);
  const [landing, setLanding] = useState(false);
  const [dropStatus, setDropStatus] = useState<{ text: string; failed: boolean } | null>(null);
  const list = useRef<ScrollBoxRenderable>(null);

  const hiddenCount = listing.entries.filter((e) => e.name.startsWith(".")).length;
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const known = new Set(listing.entries.map((e) => e.name));
    const all: ListRow[] = [...listing.entries];
    for (const arrival of arrivals) {
      if (known.has(arrival.name)) continue;
      const ghost: ListRow = {
        name: arrival.name,
        path: listing.path ? `${listing.path}/${arrival.name}` : arrival.name,
        kind: "file",
        size: arrival.size,
        modified: arrival.at,
        mode: 0,
        arriving: arrival.state,
      };
      // Same order as the Server's listing: directories first, then by name.
      const at = all.findIndex(
        (e) => !opensAsDirectory(e) && byName.compare(ghost.name, e.name) < 0,
      );
      all.splice(at === -1 ? all.length : at, 0, ghost);
    }
    const shown = all.filter(
      (e) => (prefs.hidden || !e.name.startsWith(".")) && (!q || e.name.toLowerCase().includes(q)),
    );
    return sorted(shown, prefs.sort);
  }, [listing.entries, listing.path, arrivals, prefs.hidden, prefs.sort, query]);
  // The selection follows a name, so sorting or filtering keeps it when it is still shown.
  const index = Math.max(
    0,
    rows.findIndex((e) => e.name === selectedName),
  );
  const current: ListRow | undefined = rows[index];

  useEffect(() => {
    if (current) remembered.set(listing.path, current.name);
    list.current?.scrollChildIntoView(`entry-${index}`);
  }, [current, index, listing.path]);

  // Ask for the preview of the selection; a newer selection cancels the older request.
  useEffect(() => {
    // A ghost has nothing to read yet: its preview comes once the file has landed.
    if (!current || current.arriving) return;
    const key = cacheKey(current);
    if (cache.has(key)) return;
    const controller = new AbortController();
    const loading = setTimeout(() => setSlowPath(current.path), LOADING_AFTER_MS);
    const timer = setTimeout(() => {
      app
        .withSignal(controller.signal, () => fetchPreview(current.path, imageTarget.current))
        .then(
          (preview) => {
            keep(key, preview);
            if (!controller.signal.aborted) setLoaded({ path: current.path, preview });
          },
          (error: unknown) => {
            if (controller.signal.aborted) return;
            setLoaded({
              path: current.path,
              error: error instanceof Error ? error.message : "Preview failed",
            });
          },
        );
    }, PREVIEW_DELAY_MS);
    return () => {
      clearTimeout(timer);
      clearTimeout(loading);
      controller.abort();
    };
  }, [current, app]);

  // The images next to the selection are asked for in the background, once the selection
  // rests: stepping through photos then shows each one from the cache. The Server keeps
  // their thumbnails too, so this costs it nothing on the next visit.
  useEffect(() => {
    if (!current || filtering) return;
    const neighbours = [rows[index - 1], rows[index + 1]].filter(
      (e): e is ListRow =>
        e !== undefined && !e.arriving && IMAGE_NAME.test(e.name) && !cache.has(cacheKey(e)),
    );
    if (!neighbours.length) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      for (const entry of neighbours)
        app
          .withSignal(controller.signal, () => fetchPreview(entry.path, imageTarget.current))
          .then(
            (preview) => keep(cacheKey(entry), preview),
            () => {},
          );
    }, NEIGHBOUR_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [current, index, rows, filtering, app]);

  // A selected directory is rendered in the background: Enter then shows it at once.
  useEffect(() => {
    if (!current || !opensAsDirectory(current) || filtering) return;
    const timer = setTimeout(() => {
      void router.preloadRoute({ to: "/", search: searchOf(current.path) }).catch(() => {});
    }, PRELOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [current, filtering, router]);

  const move = (delta: number) => {
    setDropStatus(null);
    const target = rows[Math.max(0, Math.min(index + delta, rows.length - 1))];
    if (target) setSelectedName(target.name);
  };
  const open = (entry: Entry | undefined) => {
    if (!entry) return;
    if (opensAsDirectory(entry)) void navigate({ to: "/", search: searchOf(entry.path) });
    else if (entry.kind === "symlink" && !entry.targetKind)
      setNotice({ about: entry.path, text: `${entry.name}: broken link` });
    else setZoomed(true);
  };
  const up = () => {
    if (!listing.path) {
      setNotice({ about: current?.path ?? "", text: "Already at the explorer root" });
      return;
    }
    const parent = parentOf(listing.path);
    remembered.set(parent, listing.path.split("/").at(-1) ?? "");
    void navigate({ to: "/", search: searchOf(parent) });
  };
  const arrival = (name: string, state: Arrival["state"] | null) =>
    setArrivals((all) =>
      state === null
        ? all.filter((a) => a.name !== name)
        : all.map((a) => (a.name === name ? { ...a, state } : a)),
    );

  // Each file is moved when the Server sees it (same machine), copied otherwise. An
  // unknown outcome is reported, never retried: the file may already have moved.
  async function land(files: Dropped[], skipped: string[]) {
    const at = Date.now();
    setArrivals((all) => [
      ...all.filter((a) => a.state !== "done" && !files.some((f) => f.name === a.name)),
      ...files.map((f) => ({ name: f.name, size: f.size, at, state: "arriving" as const })),
    ]);
    setSelectedName(files[0].name);
    setLanding(true);
    setDropStatus(null);
    const done: string[] = [];
    const problems = skipped.map((name) => `${name}: not a file`);
    for (const file of files) {
      try {
        let result = await receiveDropped(listing.path, file.name, file.source);
        if (!result.ok && result.reason === "not-local") {
          arrival(file.name, "copying");
          result =
            file.size > COPY_MAX_BYTES
              ? { ok: false, reason: "too-large" }
              : await uploadDropped(listing.path, file.name, await readDropped(file.source.path));
        }
        if (result.ok) {
          done.push(`${result.mode} ${result.name}`);
          arrival(file.name, "done");
        } else {
          problems.push(`${file.name}: ${REFUSED[result.reason]}`);
          arrival(file.name, null);
        }
      } catch (error: unknown) {
        problems.push(
          error instanceof TransportError && error.outcome === "unknown"
            ? `${file.name}: outcome unknown, check the listing (Ctrl+R)`
            : `${file.name}: ${error instanceof Error ? error.message : "failed"}`,
        );
        arrival(file.name, null);
      }
    }
    setDropStatus({ text: [...done, ...problems].join(" · "), failed: problems.length > 0 });
    setTimeout(() => setLanding(false), LANDED_MS);
  }

  // A file dropped on the terminal arrives as a pasted path (bracketed paste): it is
  // transferred at once into the directory on screen. While the filter is open, a paste
  // is text for the field.
  usePaste((event) => {
    if (filtering) return;
    void inspectDrop(decodePasteBytes(event.bytes)).then((dropped) => {
      if (!dropped) return;
      if (dropped.files.length) void land(dropped.files, dropped.skipped);
      else
        setDropStatus({
          text: `Only files can be dropped: ${dropped.skipped.join(", ")}`,
          failed: true,
        });
    });
  });

  // Leaving the filter keeps the entry it selected, even once the whole list is back.
  const closeFilter = ({ clear }: { clear: boolean }) => {
    setFiltering(false);
    if (current) setSelectedName(current.name);
    if (clear) setQuery("");
  };

  useBindings(() => {
    const mode = filtering
      ? [
          {
            key: "return",
            cmd: () => closeFilter({ clear: false }),
            desc: "done",
            group: "files",
          },
          {
            key: "escape",
            cmd: () => closeFilter({ clear: true }),
            desc: "clear",
            group: "files",
          },
          { key: "down", cmd: () => move(1) },
          { key: "up", cmd: () => move(-1) },
        ]
      : zoomed
        ? [
            {
              key: "escape",
              cmd: () => setZoomed(false),
              desc: "back to list",
              group: "files",
            },
            { key: "left", cmd: () => setZoomed(false) },
            { key: "h", cmd: () => setZoomed(false) },
            { key: "backspace", cmd: () => setZoomed(false) },
            { key: "return", cmd: () => setZoomed(false) },
          ]
        : [
            { key: "j", cmd: () => move(1), desc: "down", group: "files" },
            { key: "k", cmd: () => move(-1), desc: "up", group: "files" },
            { key: "down", cmd: () => move(1) },
            { key: "up", cmd: () => move(-1) },
            { key: "pagedown", cmd: () => move(PAGE_ROWS) },
            { key: "pageup", cmd: () => move(-PAGE_ROWS) },
            { key: "g", cmd: () => move(-rows.length) },
            { key: "shift+g", cmd: () => move(rows.length) },
            { key: "return", cmd: () => open(current), desc: "open", group: "files" },
            { key: "right", cmd: () => open(current) },
            { key: "l", cmd: () => open(current) },
            { key: "backspace", cmd: up, desc: "parent", group: "files" },
            { key: "left", cmd: up },
            { key: "h", cmd: up },
            {
              key: "/",
              cmd: () => setFiltering(true),
              desc: "filter",
              group: "files",
            },
            // Esc closes what is open: the key list first, then the filter.
            ...(help
              ? [{ key: "escape", cmd: () => setHelp(false) }]
              : query
                ? [{ key: "escape", cmd: () => closeFilter({ clear: true }) }]
                : []),
            {
              key: ".",
              cmd: () => prefsStore.update({ hidden: !prefs.hidden }),
              desc: "hidden",
              group: "files",
            },
            {
              key: "s",
              cmd: () => prefsStore.update({ sort: next(SORTS, prefs.sort) }),
              desc: "sort",
              group: "files",
            },
            ...(listing.path
              ? [{ key: "~", cmd: () => void navigate({ to: "/", search: {} }) }]
              : []),
            ...(canGoBack
              ? [{ key: "u", cmd: () => router.history.back(), desc: "back", group: "files" }]
              : []),
            { key: "?", cmd: () => setHelp((shown) => !shown), desc: "keys", group: "files" },
          ];
    return { bindings: mode };
  }, [
    filtering,
    zoomed,
    help,
    rows,
    index,
    current,
    query,
    prefs,
    listing.path,
    canGoBack,
    router,
  ]);

  // Rows only re-render when their own state changes: a move redraws two rows, not 5000.
  const pressed = useRef<(entry: Entry, active: boolean) => void>(() => {});
  useEffect(() => {
    pressed.current = (entry, active) => (active ? open(entry) : setSelectedName(entry.name));
  });
  const press = useCallback((entry: Entry, active: boolean) => pressed.current(entry, active), []);
  const hover = useCallback(
    (name: string, inside: boolean) => setHovered((h) => (inside ? name : h === name ? null : h)),
    [],
  );
  const listWidth = Math.max(LIST_MIN, Math.min(LIST_MAX, Math.round(width * LIST_SHARE)));
  const showPreview = zoomed || width >= PREVIEW_MIN_WIDTH;
  // A preview seen before is shown from the cache, without waiting for the effect.
  const hit = current ? cache.get(cacheKey(current)) : undefined;
  const ready: Loaded | null = !current
    ? null
    : hit
      ? { path: current.path, preview: hit }
      : loaded?.path === current.path
        ? loaded
        : null;
  const slow = current !== undefined && slowPath === current.path;
  const shownNotice = notice && notice.about === (current?.path ?? "") ? notice.text : "";

  return (
    <box flexDirection="column" flexGrow={1} gap={1}>
      <box flexDirection="row" gap={1} height={1} flexShrink={0}>
        <text width={8} flexShrink={0} fg={filtering ? color.accent : color.muted}>
          / filter
        </text>
        <input
          id="filter"
          focused={filtering}
          value={query}
          onInput={setQuery}
          placeholder="type to narrow this directory"
          flexGrow={1}
        />
        <text id="list-status" flexShrink={0} wrapMode="none" fg={color.muted}>
          {rows.length}/{listing.entries.length} shown · dotfiles{" "}
          {!hiddenCount ? "none" : prefs.hidden ? "shown" : `hidden (${hiddenCount})`} · by{" "}
          {prefs.sort}
        </text>
      </box>
      <box flexDirection="row" flexGrow={1} gap={1}>
        {zoomed ? null : (
          <box flexDirection="column" width={listWidth} flexShrink={0} gap={1}>
            <scrollbox
              id="entries"
              ref={list}
              flexGrow={1}
              scrollY
              border
              borderColor={filtering || landing ? color.accent : color.border}
              title={` ${listing.path.split("/").at(-1) || "root"} `}
            >
              {rows.length === 0 ? (
                <Line fg={color.muted}>
                  {query
                    ? "No match"
                    : listing.entries.length
                      ? "Only dotfiles here · . shows them"
                      : "Empty directory"}
                </Line>
              ) : null}
              {rows.map((entry, i) => (
                <Row
                  key={entry.name}
                  entry={entry}
                  index={i}
                  active={i === index}
                  hovered={hovered === entry.name}
                  onHover={hover}
                  onPress={press}
                />
              ))}
            </scrollbox>
            <Details entry={current} preview={ready} compact={height < DETAILS_MIN_HEIGHT} />
          </box>
        )}
        {showPreview ? (
          <box
            id="preview"
            flexDirection="column"
            flexGrow={1}
            border
            borderColor={zoomed ? color.accent : color.border}
            paddingX={1}
            title={help ? " keys " : ` ${current?.name ?? "preview"} `}
          >
            {help ? (
              <KeyHelp groups={["files", "preview", "global", "airtty"]} />
            ) : !current ? (
              <Line fg={color.muted}>Nothing selected</Line>
            ) : current.arriving ? (
              <Pulse>
                <Line fg={color.accent}>
                  {current.arriving === "done"
                    ? `${current.name} has landed · refreshing the listing…`
                    : `${current.name} is ${current.arriving === "copying" ? "being copied" : "arriving"} into ${listing.path || "the root"}…`}
                </Line>
              </Pulse>
            ) : ready && "preview" in ready ? (
              <PreviewPane
                entry={current}
                preview={ready.preview}
                zoomed={zoomed}
                active={!filtering}
              />
            ) : ready ? (
              <Line fg={color.danger}>Preview failed · {ready.error}</Line>
            ) : slow ? (
              <Pulse>
                <Line fg={color.muted}>Reading {current.name}…</Line>
                <SkeletonRows count={10} width={48} />
              </Pulse>
            ) : null}
          </box>
        ) : null}
      </box>
      {
        <Line
          id="notice"
          fg={dropStatus && !dropStatus.failed && !shownNotice ? color.ok : color.warn}
        >
          {shownNotice ||
            dropStatus?.text ||
            (listing.truncated ? "Large directory: only the first 5000 entries are listed" : "")}
        </Line>
      }
    </box>
  );
}

const Row = memo(function Row({
  entry,
  index,
  active,
  hovered,
  onHover,
  onPress,
}: {
  entry: ListRow;
  index: number;
  active: boolean;
  hovered: boolean;
  onHover: (name: string, inside: boolean) => void;
  onPress: (entry: Entry, active: boolean) => void;
}) {
  const directory = opensAsDirectory(entry);
  // A ghost is dimmed and marked ↓ until its transfer ends; landed, it reads ✓ until the
  // refreshed listing replaces it with the real entry.
  const ghost = entry.arriving && entry.arriving !== "done";
  const { glyph, fg } = !entry.arriving
    ? glyphOf(entry)
    : ghost
      ? { glyph: "↓", fg: color.accent }
      : { glyph: "✓", fg: color.ok };
  return (
    <box
      id={`entry-${index}`}
      flexDirection="row"
      height={1}
      flexShrink={0}
      backgroundColor={active ? color.selected : hovered ? color.panel : undefined}
      onMouseOver={() => onHover(entry.name, true)}
      onMouseOut={() => onHover(entry.name, false)}
      onMouseDown={() => onPress(entry, active)}
    >
      <text width={2} flexShrink={0} fg={fg}>
        {glyph}
      </text>
      <text
        flexGrow={1}
        wrapMode="none"
        truncate
        fg={ghost ? color.muted : directory && !active ? color.info : color.text}
      >
        {entry.name}
        {directory ? "/" : ""}
      </text>
      <text width={9} flexShrink={0} wrapMode="none" fg={ghost ? color.accent : color.muted}>
        {ghost
          ? `${entry.arriving}…`.padStart(SIZE_WIDTH)
          : directory
            ? ""
            : size(entry.size).padStart(SIZE_WIDTH)}
      </text>
    </box>
  );
});

function Details({
  entry,
  preview,
  compact,
}: {
  entry: ListRow | undefined;
  preview: Loaded | null;
  compact: boolean;
}) {
  if (!entry) return <Line fg={color.muted}>No entry</Line>;
  const shown = preview && "preview" in preview ? preview.preview : null;
  const children = shown?.kind === "directory" ? shown.total : null;
  const dimensions = shown?.kind === "image" ? shown : null;
  const facts: { label: string; value: string; fg?: string }[] = [
    {
      label: "type",
      value: `${typeOf(entry)}${dimensions ? ` · ${dimensions.width}×${dimensions.height} px` : ""}`,
      fg: glyphOf(entry).fg,
    },
    {
      label: "size",
      value: opensAsDirectory(entry)
        ? children !== null
          ? `${children} entr${children === 1 ? "y" : "ies"}`
          : preview
            ? "—"
            : "…"
        : `${size(entry.size)} · ${bytes.format(entry.size)} bytes`,
    },
    {
      label: "modified",
      value: entry.arriving
        ? "dropped just now"
        : `${date(entry.modified)} · ${ago(entry.modified)}`,
    },
    { label: "mode", value: entry.arriving ? "—" : permissions(entry.mode) },
  ];
  if (entry.kind === "symlink")
    facts.push({
      label: "link",
      value: `→ ${entry.target ?? "?"}`,
      fg: entry.targetKind ? color.info : color.danger,
    });
  // A short terminal keeps the list usable: the details fold into one line.
  if (compact)
    return <Line id="details">{facts.map((f) => f.value.split(" · ")[0]).join(" · ")}</Line>;
  return (
    <box
      id="details"
      height={DETAILS_ROWS + 2}
      flexShrink={0}
      flexDirection="column"
      border
      borderColor={color.border}
      paddingX={1}
      title=" details "
    >
      {[{ label: "name", value: entry.name }, ...facts].map((f) => (
        <box key={f.label} flexDirection="row" height={1} flexShrink={0}>
          <text width={10} flexShrink={0} fg={color.muted}>
            {f.label}
          </text>
          <text flexGrow={1} wrapMode="none" truncate fg={f.fg ?? color.text}>
            {f.value}
          </text>
        </box>
      ))}
    </box>
  );
}
