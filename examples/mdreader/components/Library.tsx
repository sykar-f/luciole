"use client";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useTerminalDimensions } from "@opentui/react";
import type { ScrollBoxRenderable } from "@opentui/core";
import {
  KeyHelp,
  useApplication,
  useBindings,
  useCanGoBack,
  useConnection,
  useInvalidation,
  useLive,
  useLocation,
  useNavigate,
  useParams,
  useRouter,
} from "luciole/client";
import { listDocs, watchLibrary } from "../actions/library";
import { Line } from "./frames";
import { Help } from "./Help";
import type { DocEntry, Library } from "./model";
import { color } from "./theme";

const SIDEBAR = 34;
// Below this width the document takes the whole screen; the list shows while it has
// the focus (browsing or finding).
const WIDE = 96;
const PRELOAD_DELAY_MS = 150;
// Browsing the list opens the selected document once the arrows pause this long.
const BROWSE_DELAY_MS = 120;
// How long the header says a document was reloaded from disk.
const RELOADED_SHOWN_MS = 4000;

/**
 * Which pane owns the keys, like a two-pane file viewer: in `list` the arrows select a
 * document, in `doc` they scroll it. In `find` the finder's field owns the letters, in
 * `outline` the document's outline owns the arrows.
 */
export type Mode = "list" | "doc" | "find" | "outline";
type LibraryContextValue = {
  mode: Mode;
  setMode: Dispatch<SetStateAction<Mode>>;
};
const LibraryContext = createContext<LibraryContextValue>({ mode: "doc", setMode: () => {} });
export const useMode = () => useContext(LibraryContext);

const directory = (path: string) => path.split("/").slice(0, -1);

/** Every word of the query, in the path, case-insensitive. */
const matches = (doc: DocEntry, query: string) => {
  const path = doc.path.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => path.includes(word));
};

type Row =
  | { kind: "dir"; key: string; depth: number; name: string }
  | { kind: "doc"; key: string; depth: number; name: string; doc: DocEntry };
/** The documents as a tree: a directory heading each time the path leaves the previous one. */
function tree(docs: DocEntry[]): Row[] {
  const rows: Row[] = [];
  let previous: string[] = [];
  for (const doc of docs) {
    const dir = directory(doc.path);
    let shared = 0;
    while (shared < Math.min(dir.length, previous.length) && dir[shared] === previous[shared])
      shared++;
    for (let depth = shared; depth < dir.length; depth++)
      rows.push({
        kind: "dir",
        key: `dir:${dir.slice(0, depth + 1).join("/")}`,
        depth,
        name: dir[depth],
      });
    rows.push({
      kind: "doc",
      key: doc.path,
      depth: dir.length,
      name: doc.path.split("/").at(-1) ?? doc.path,
      doc,
    });
    previous = dir;
  }
  return rows;
}

/** Changes on disk arrive through a live Server Function; each one revalidates the screen. */
function Watcher({ onChange, onEnd }: { onChange: () => void; onEnd: () => void }) {
  const { items, done } = useLive(watchLibrary, [], { limit: 1 });
  const last = items.at(-1);
  const handlers = useRef({ onChange, onEnd });
  useEffect(() => {
    handlers.current = { onChange, onEnd };
  });
  useEffect(() => {
    // 0 is the heartbeat before any change; a repeated value does not re-run this effect.
    if (last) handlers.current.onChange();
  }, [last]);
  useEffect(() => {
    if (done) handlers.current.onEnd();
  }, [done]);
  return null;
}

/**
 * Persistent chrome of the reader: the library on the left survives navigation between
 * documents (selection, filter, scroll), only the document pane waits for the Server.
 */
export function LibraryChrome({ children }: { children: ReactNode }) {
  const app = useApplication();
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const { status, error, activity, refresh } = useConnection();
  const { width } = useTerminalDimensions();
  const pathname = useLocation({ select: (l) => l.pathname });
  const splat = useParams({ strict: false, select: (p) => p._splat });
  const [library, setLibrary] = useState<Library | null>(null);
  const [focus, setMode] = useState<Mode>("list");
  const [query, setQuery] = useState("");
  const [pick, setPick] = useState(0);
  // The document selected in the list while browsing, until it is the open one.
  const [cursor, setCursor] = useState<string | null>(null);
  // Keys can arrive faster than renders (`jjj` in one read): moves start from here.
  const cursorNow = useRef<string | null>(null);
  // Where Escape returns from the finder.
  const beforeFind = useRef<Mode>("list");
  const [help, setHelp] = useState(false);
  const [watch, setWatch] = useState({ key: 0, on: true });
  // Set when a change on disk was applied; cleared after a few seconds.
  const [reloaded, setReloaded] = useState(0);
  const list = useRef<ScrollBoxRenderable>(null);

  // A read through a Server Function: no route loader refreshes it, an invalidation does.
  const load = () => void listDocs().then(setLibrary, () => {});
  useEffect(load, []);
  useInvalidation(load);

  const docs = useMemo(() => library?.docs ?? [], [library]);
  // A single file has no list: the document takes the screen and keeps the keys.
  const single = library?.single ?? false;
  const mode: Mode = single && (focus === "list" || focus === "find") ? "doc" : focus;
  const current = pathname === "/" ? (library?.home ?? null) : (splat ?? null);
  const selected = cursor ?? current;
  const index = docs.findIndex((d) => d.path === selected);
  const found = useMemo(
    () => (mode === "find" && query.trim() ? docs.filter((d) => matches(d, query.trim())) : docs),
    [docs, mode, query],
  );
  const rows = useMemo(() => (mode === "find" ? null : tree(docs)), [docs, mode]);

  const point = (path: string | null) => {
    cursorNow.current = path;
    setCursor(path);
  };
  /** An explicit open (Enter, click, ] and [) is a new history entry. */
  const open = (path: string) => {
    point(null);
    void navigate({ to: "/doc/$", params: { _splat: path } });
  };
  const step = (delta: number) => {
    if (!docs.length) return;
    const target = index < 0 ? (delta > 0 ? 0 : docs.length - 1) : index + delta;
    if (target >= 0 && target < docs.length) open(docs[target].path);
  };
  const back = () => {
    point(null);
    router.history.back();
  };
  // Browsing: the selection moves at once, the document follows (see the effect below).
  const select = (target: (from: number) => number) => {
    const from = docs.findIndex((d) => d.path === (cursorNow.current ?? current));
    const doc = docs[Math.max(0, Math.min(target(from), docs.length - 1))];
    if (doc) point(doc.path);
  };
  const read = () => {
    if (cursorNow.current && cursorNow.current !== current) open(cursorNow.current);
    setMode("doc");
  };
  const find = () => {
    beforeFind.current = mode;
    setQuery("");
    setPick(Math.max(0, index));
    setMode("find");
  };
  const choose = () => {
    const doc = found[Math.min(pick, found.length - 1)];
    setMode("doc");
    if (doc) open(doc.path);
  };
  const movePick = (delta: number) =>
    setPick((p) => Math.max(0, Math.min(p + delta, found.length - 1)));

  // The selected document replaces the open one once the arrows pause: browsing does not
  // fill the history (u returns to where browsing started) nor the network.
  useEffect(() => {
    if (!cursor || cursor === current) return;
    const timer = setTimeout(() => {
      void navigate({ to: "/doc/$", params: { _splat: cursor }, replace: true }).then(() => {
        if (cursorNow.current === cursor) point(null);
      });
    }, BROWSE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [cursor, current, navigate]);

  // The neighbours of the selected document are rendered in the background: the next
  // arrow, ] or [ shows them without waiting for the Server (TanStack preload cache).
  useEffect(() => {
    if (index < 0 || mode === "find") return;
    const timer = setTimeout(() => {
      for (const neighbour of [docs[index + 1], docs[index - 1]])
        if (neighbour)
          void router
            .preloadRoute({ to: "/doc/$", params: { _splat: neighbour.path } })
            .catch(() => {});
    }, PRELOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [index, docs, mode, router]);

  // Keep the selected document (or the finder's pick) visible in the list.
  const visible = mode === "find" ? found[Math.min(pick, found.length - 1)]?.path : selected;
  useEffect(() => {
    if (visible) list.current?.scrollChildIntoView(`library-row-${visible}`);
  }, [visible, rows, found]);

  // The "reloaded" notice fades out on its own.
  useEffect(() => {
    if (!reloaded) return;
    const timer = setTimeout(() => setReloaded(0), RELOADED_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [reloaded]);

  const reload = () => {
    void refresh();
    load();
    // Nothing reconnects by itself: a stopped watch starts again with the refresh.
    if (!watch.on) setWatch((w) => ({ ...w, key: w.key + 1, on: true }));
  };
  useBindings(
    () => ({
      bindings: [
        { key: "ctrl+r", cmd: reload, desc: "reload", group: "global" },
        ...(mode === "find"
          ? [
              { key: "return", cmd: choose, desc: "open", group: "library" },
              {
                key: "escape",
                cmd: () => setMode(beforeFind.current),
                desc: "cancel",
                group: "library",
              },
              { key: "down", cmd: () => movePick(1) },
              { key: "up", cmd: () => movePick(-1) },
              { key: "ctrl+n", cmd: () => movePick(1) },
              { key: "ctrl+p", cmd: () => movePick(-1) },
            ]
          : mode === "outline"
            ? []
            : [
                ...(mode === "list"
                  ? [
                      { key: "j", cmd: () => select((i) => i + 1), desc: "down", group: "list" },
                      { key: "k", cmd: () => select((i) => i - 1), desc: "up", group: "list" },
                      { key: "down", cmd: () => select((i) => i + 1) },
                      { key: "up", cmd: () => select((i) => i - 1) },
                      { key: "g", cmd: () => select(() => 0) },
                      { key: "home", cmd: () => select(() => 0) },
                      { key: "shift+g", cmd: () => select(() => docs.length - 1) },
                      { key: "end", cmd: () => select(() => docs.length - 1) },
                      { key: "return", cmd: read, desc: "read", group: "list" },
                      { key: "right", cmd: read },
                      { key: "l", cmd: read },
                    ]
                  : []),
                ...(single
                  ? []
                  : [
                      // Enter already reads from the list: Tab is described only there.
                      mode === "list"
                        ? { key: "tab", cmd: read }
                        : {
                            key: "tab",
                            cmd: () => setMode("list"),
                            desc: "files",
                            group: "library",
                          },
                      ...(mode === "doc"
                        ? [
                            { key: "left", cmd: () => setMode("list") },
                            { key: "h", cmd: () => setMode("list") },
                          ]
                        : []),
                      { key: "]", cmd: () => step(1), desc: "next doc", group: "library" },
                      { key: "[", cmd: () => step(-1), desc: "previous", group: "library" },
                      { key: "shift+j", cmd: () => step(1) },
                      { key: "shift+k", cmd: () => step(-1) },
                      { key: "/", cmd: find, desc: "find", group: "library" },
                    ]),
                ...(canGoBack ? [{ key: "u", cmd: back, desc: "back", group: "library" }] : []),
                { key: "?", cmd: () => setHelp((shown) => !shown), desc: "keys", group: "library" },
              ]),
      ],
    }),
    [mode, single, found, pick, docs, index, current, canGoBack, router, watch.on],
  );

  const browsing = mode === "list" || mode === "find";
  const sidebar = Boolean(library) && !single && (width >= WIDE || browsing);
  const rootName = library?.root.split("/").filter(Boolean).at(-1) ?? "library";
  const row = (key: string, depth: number, label: ReactNode, doc: DocEntry | null) => {
    const active = doc !== null && doc.path === visible;
    return (
      <box
        key={key}
        id={doc ? `library-row-${doc.path}` : undefined}
        height={1}
        flexShrink={0}
        paddingLeft={depth * 2}
        // The selection is bright while the list has the keys, dim while reading.
        backgroundColor={active ? (browsing ? color.selected : color.panel) : undefined}
        onMouseDown={
          doc
            ? () => {
                setMode("list");
                open(doc.path);
              }
            : undefined
        }
      >
        <Line fg={doc === null ? color.muted : active ? color.accent : color.text}>{label}</Line>
      </box>
    );
  };

  return (
    <LibraryContext.Provider value={{ mode, setMode }}>
      <box flexDirection="column" flexGrow={1} paddingX={1} gap={1}>
        <box id="reader-heading" height={1} flexShrink={0} flexDirection="row" gap={2}>
          <text flexShrink={0} fg={color.accent}>
            <strong>MDREADER</strong>
          </text>
          <text flexGrow={1} wrapMode="none" truncate fg={color.muted}>
            {!library
              ? "…"
              : single
                ? `${library.root}/${library.home}`
                : `${library.root} · ${docs.length}${library.truncated ? "+" : ""} document${docs.length === 1 ? "" : "s"}`}
          </text>
          <text
            flexShrink={0}
            wrapMode="none"
            fg={reloaded ? color.ok : watch.on ? color.faint : color.warn}
          >
            {reloaded
              ? "↻ reloaded from disk"
              : watch.on
                ? "● watching"
                : "○ watch stopped · Ctrl+R"}
          </text>
          <text
            flexShrink={0}
            wrapMode="none"
            fg={status === "connected" ? color.faint : color.warn}
          >
            {status}
            {activity === "refresh" ? " · Refreshing…" : ""}
            {activity === "navigate" ? " · Esc cancel" : ""}
          </text>
        </box>
        {error ? <Line fg={color.warn}>{error}</Line> : null}
        <box flexDirection="row" flexGrow={1} gap={2}>
          {sidebar ? (
            <box
              id="library"
              width={SIDEBAR}
              flexShrink={0}
              flexDirection="column"
              border
              borderColor={browsing ? color.accent : color.border}
              paddingX={1}
              title={` ${rootName} `}
            >
              {mode === "find" ? (
                <box flexDirection="row" height={1} flexShrink={0} gap={1}>
                  <Line fg={color.accent}>/</Line>
                  <input
                    id="library-find"
                    focused
                    value={query}
                    onInput={(value) => {
                      setQuery(value);
                      setPick(0);
                    }}
                    placeholder="name or path"
                    flexGrow={1}
                  />
                </box>
              ) : (
                <Line fg={color.faint}>/ find a document</Line>
              )}
              <scrollbox id="library-list" ref={list} flexGrow={1} scrollY>
                {library?.problem ? <Line fg={color.warn}>{library.problem}</Line> : null}
                {library && !library.problem && !docs.length ? (
                  <Line fg={color.muted}>No Markdown file</Line>
                ) : null}
                {rows
                  ? rows.map((r) =>
                      row(
                        r.key,
                        r.depth,
                        r.kind === "dir" ? `▾ ${r.name}/` : r.name,
                        r.kind === "doc" ? r.doc : null,
                      ),
                    )
                  : found.map((doc) => row(doc.path, 0, doc.path, doc))}
                {mode === "find" && !found.length ? <Line fg={color.muted}>No match</Line> : null}
              </scrollbox>
              {library?.truncated ? (
                <Line fg={color.warn}>List stopped at {docs.length} documents</Line>
              ) : null}
            </box>
          ) : null}
          <box flexDirection="column" flexGrow={1}>
            {children}
          </box>
        </box>
        <box id="reader-footer" height={1} flexShrink={0}>
          <Help groups={["list", "library", "global", "luciole"]} />
        </box>
        {help ? (
          <box
            id="keys"
            position="absolute"
            right={2}
            bottom={2}
            zIndex={10}
            border
            borderColor={color.accentDim}
            backgroundColor={color.panel}
            title=" keys · ? to close "
            paddingX={1}
          >
            <KeyHelp fg={color.text} accent={color.accent} />
          </box>
        ) : null}
        <Watcher
          key={watch.key}
          onChange={() => {
            // Revalidates the open document and, through useInvalidation, the list.
            void app.invalidate();
            setReloaded(Date.now());
          }}
          onEnd={() => setWatch((w) => ({ ...w, on: false }))}
        />
      </box>
    </LibraryContext.Provider>
  );
}
