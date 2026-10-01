/** @jsxImportSource @opentui/react */
/**
 * `run()` in a page (src/run.tsx): the Application in an xterm.js terminal filling an
 * element, OpenTUI on opentui.wasm behind it, its Server on this page's origin. The page
 * is a window of its own, as in the desktop host (docs/DESKTOP.md): Ctrl+C belongs to the
 * application; closing the tab keeps the session, quitting forgets it.
 */
import { PassThrough } from "node:stream";
import * as z from "zod/mini";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { Shell, type Application, type ApplicationOptions } from "../../client";
import type { Session } from "../../restore";
import { isInputStream, terminalOutput } from "../streams";
import { wheelRoom } from "../wheel-room";
import {
  controlledNetwork,
  embedded,
  onInput,
  tellTyped,
  exposeScreen,
  exposeScrollRoom,
  stage,
  tellEvent,
  type Grid,
  type Look,
} from "../embed";

/** What `run()` gives the function that creates its Application. */
export type RunOptions = Pick<
  ApplicationOptions,
  "url" | "fetch" | "token" | "latencyMs" | "network" | "session" | "wrapTransport" | "quitOnCtrlC"
>;
export type PageOptions = {
  /** The element the terminal fills. */
  element: HTMLElement;
  /** The Server's base URL: this page's origin unless a Worker answers (docs/WEB.md). */
  server: URL;
  fetch?: ApplicationOptions["fetch"];
  name: string;
  /** Keys the restored session, instead of the Server's URL. */
  sessionKey?: string;
  /** `false`: no session restored, none kept (embed.ts, `restoreOf`). */
  restore?: boolean;
} & Look;

const SAVE_DELAY_MS = 200;
/** What terminals draw with, before a generic monospace. */
const FONTS =
  'ui-monospace, "SF Mono", Menlo, "Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace';
const LARGEST_FONT = 24;
const SMALLEST_FONT = 4;
const FONT_STEP = 0.25;

/**
 * The largest font, on steps of FONT_STEP, at which `grid` fits the element, then exactly
 * that grid. A bisection: every measure re-lays the terminal out, and a page that frames
 * the runtime (a gallery tab) resizes it often. A hidden element, with no size, is left as
 * it is: nothing would fit, and every size would be measured for nothing.
 */
function fitGrid(terminal: XTerm, fit: FitAddon, grid: Grid, element: HTMLElement) {
  if (!element.clientWidth || !element.clientHeight) return;
  const fits = (size: number) => {
    terminal.options.fontSize = size;
    const room = fit.proposeDimensions();
    return room !== undefined && room.cols >= grid.columns && room.rows >= grid.rows;
  };
  // Sizes SMALLEST_FONT + k × FONT_STEP: the largest k that fits, else the smallest size.
  let low = 0;
  let high = (LARGEST_FONT - SMALLEST_FONT) / FONT_STEP;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(SMALLEST_FONT + middle * FONT_STEP)) low = middle;
    else high = middle - 1;
  }
  terminal.options.fontSize = SMALLEST_FONT + low * FONT_STEP;
  terminal.resize(grid.columns, grid.rows);
}
const StoredSession = z.object({
  index: z.number().check(z.int(), z.gte(0)),
  entries: z.array(z.object({ href: z.string(), fields: z.record(z.string(), z.string()) })),
});

/** The tab's session, as the terminal's session file keeps it: in `localStorage`. */
function pageSession(key: string) {
  const read = (): Session | undefined => {
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw === null ? undefined : StoredSession.safeParse(JSON.parse(raw));
      return parsed?.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const write = (session: Session) => {
    try {
      localStorage.setItem(key, JSON.stringify(session));
    } catch {
      // Storage full or denied: the page still runs, without restoring.
    }
  };
  return {
    restored: read(),
    schedule(session: Session) {
      clearTimeout(timer);
      timer = setTimeout(() => write(session), SAVE_DELAY_MS);
    },
    flush(session: Session) {
      clearTimeout(timer);
      write(session);
    },
    remove() {
      clearTimeout(timer);
      localStorage.removeItem(key);
    },
  };
}

/** A session neither read nor written: the application starts at its first route each time. */
const forgotten = { restored: undefined, schedule() {}, flush() {}, remove() {} };

/**
 * The cell under a point of the page, 0-based, as xterm.js reports the mouse: from the
 * screen element's box and the grid. None outside the grid (the padding around it).
 */
function cellAt(terminal: XTerm, x: number, y: number) {
  const box = terminal.element?.querySelector(".xterm-screen")?.getBoundingClientRect();
  if (!box?.width || !box.height) return undefined;
  const column = Math.floor(((x - box.left) / box.width) * terminal.cols);
  const row = Math.floor(((y - box.top) / box.height) * terminal.rows);
  if (column < 0 || row < 0 || column >= terminal.cols || row >= terminal.rows) return undefined;
  return { column, row };
}

/** The visible rows as text, read from the active buffer. */
function screenLines(terminal: XTerm) {
  const buffer = terminal.buffer.active;
  return Array.from(
    { length: terminal.rows },
    (_, y) => buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? "",
  );
}

export async function runInPage(
  create: (options: RunOptions) => Application,
  {
    element,
    server,
    fetch,
    name,
    sessionKey,
    restore = true,
    grid,
    background,
    foreground,
  }: PageOptions,
) {
  const terminal = new XTerm({
    cursorBlink: true,
    allowProposedApi: true,
    fontFamily: FONTS,
    theme: { background, foreground },
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(element);
  // Framed, the embedding page reads the screen from the buffer, not from the rows
  // xterm.js draws: those stop being drawn while the frame is out of view.
  if (embedded) exposeScreen(() => screenLines(terminal));
  const layout = () => (grid ? fitGrid(terminal, fit, grid, element) : fit.fit());
  layout();
  // In a page of its own, the terminal is what the reader came for. Framed, a focus
  // would scroll the embedding page to it: the reader clicks it instead.
  if (!embedded) terminal.focus();
  const stdin = new PassThrough();
  if (!isInputStream(stdin)) throw new Error("unreachable: a PassThrough is readable");
  // Framed, the embedding page may slow the network down and hears what crosses it; it
  // may also put the round trip before the keys, as SSH would.
  const control = embedded
    ? controlledNetwork(fetch ?? ((input, init) => globalThis.fetch(input, init)))
    : undefined;
  const write = (data: string) => stdin.write(data);
  const typed = control ? control.keys(write) : write;
  terminal.onData((data) => {
    tellTyped(data);
    typed(data);
  });
  onInput(write);

  const session = restore
    ? pageSession(`luciole:session:${name}:${sessionKey ?? server.href}`)
    : forgotten;
  const app = create({
    url: server.href,
    fetch: control?.fetch ?? fetch,
    network: control?.network,
    session: session.restored,
    quitOnCtrlC: false,
  });
  app.onEvent(tellEvent);
  session.flush(app.restoration.snapshot());
  app.restoration.subscribe(() => session.schedule(app.restoration.snapshot()));
  addEventListener("pagehide", () => session.flush(app.restoration.snapshot()));

  // OpenTUI replaces the global requestAnimationFrame with its render loop's (renderer.ts),
  // and xterm.js draws through it: after a focus change a request can wait there forever,
  // the terminal no longer drawn. The page keeps the browser's.
  const { requestAnimationFrame, cancelAnimationFrame } = globalThis;
  const size = { columns: terminal.cols, rows: terminal.rows };
  const renderer = await createCliRenderer({
    stdin,
    stdout: terminalOutput(size, (chunk, done) => terminal.write(chunk, done)),
    width: size.columns,
    height: size.rows,
    useThread: false,
    exitOnCtrlC: false,
    exitSignals: [],
  });
  Object.assign(globalThis, { requestAnimationFrame, cancelAnimationFrame });
  // Framed, the embedding page asks at each turn of the wheel whether the application
  // still scrolls under the pointer. Without mouse tracking the wheel reaches nothing it
  // draws: xterm.js would turn it into arrow keys.
  if (embedded)
    exposeScrollRoom((x, y) => {
      const cell = cellAt(terminal, x, y);
      if (!cell || terminal.modes.mouseTrackingMode === "none") return { up: false, down: false };
      return wheelRoom(renderer, cell.column, cell.row);
    });
  terminal.onResize(({ cols, rows }) => renderer.resize(cols, rows));
  new ResizeObserver(layout).observe(element);
  stage("terminal");
  app.quit = () => {
    session.remove();
    renderer.destroy();
    terminal.write("\r\n\x1b[2mSession ended. Reload the page to start again.\x1b[0m\r\n");
  };
  createRoot(renderer).render(<Shell app={app} />);
  requestAnimationFrame(() => stage("drawn"));
  return app;
}

/**
 * The terminal's contract in a page: the element `#luciole`, the Server on this origin.
 * `runInPage` takes both explicitly.
 */
export async function run(
  create: (options: RunOptions) => Application,
  { name = "luciole", sessionKey }: { name?: string; sessionKey?: string } = {},
) {
  const element = document.getElementById("luciole");
  if (!element) throw new Error("The page has no #luciole element to run in");
  await runInPage(create, { element, server: new URL("/", location.href), name, sessionKey });
}
