/** @jsxImportSource @opentui/react */
/**
 * `run()` in a page (src/run.tsx): the Application in an xterm.js terminal filling an
 * element, OpenTUI on opentui.wasm behind it, its Server on this page's origin. The page
 * is a window of its own, as in the desktop host (docs/DESKTOP.md): Ctrl+C belongs to the
 * application; closing the tab keeps the session, quitting forgets it.
 */
import { definedProperties } from "../../defined-properties";
import { messageOf } from "../../guards";
import { PassThrough } from "node:stream";
import * as z from "zod/mini";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { attachTerminalView, cellAt, wheelReports } from "../terminal-view";
import { OrdinaryPixelInput } from "../../pixel-scroll/ordinary-input";
import { PixelController } from "../../pixel-scroll/controller";
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
  exposeCells,
  exposeRenderer,
  exposeScreen,
  exposeScrollRoom,
  exposeWrites,
  stage,
  tellEvent,
  type Grid,
  type Look,
  type Run,
} from "../embed";

/** What `run()` gives the function that creates its Application. */
export type RunOptions = Pick<
  ApplicationOptions,
  | "url"
  | "fetch"
  | "token"
  | "latencyMs"
  | "network"
  | "session"
  | "initialPath"
  | "wrapTransport"
  | "quitOnCtrlC"
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
  /** The route to open when no session is restored (embed.ts, `pathOf`). */
  path?: string;
  /** `false` keeps row scrolling in the web runtime. Enabled by default. */
  pixelScroll?: boolean;
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

/** The visible rows as text, read from the active buffer. */
function screenLines(terminal: XTerm) {
  const buffer = terminal.buffer.active;
  return Array.from(
    { length: terminal.rows },
    (_, y) => buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? "",
  );
}

/**
 * The visible cells as drawn, each its text and its style in one string, so that a cell
 * rewritten the same is told from one changed; "" past a wide character. Read from the
 * buffer: the GPU renderer leaves nothing in the DOM to read.
 */
function screenCells(terminal: XTerm): string[][] {
  const buffer = terminal.buffer.active;
  const cell = buffer.getNullCell();
  return Array.from({ length: terminal.rows }, (_, y) => {
    const line = buffer.getLine(buffer.viewportY + y);
    return Array.from({ length: terminal.cols }, (_, x) => {
      if (!line?.getCell(x, cell)) return "";
      const style = [
        cell.isBold(),
        cell.isItalic(),
        cell.isDim(),
        cell.isUnderline(),
        cell.isInverse(),
        cell.isStrikethrough(),
      ]
        .map((on) => (on ? "1" : "0"))
        .join("");
      return `${cell.getChars()}|${cell.getFgColorMode()}:${cell.getFgColor()}|${cell.getBgColorMode()}:${cell.getBgColor()}|${style}`;
    });
  });
}

/**
 * What each render of the terminal rewrote: the cells that differ from the last render,
 * as runs along their rows, told to whoever listens (the embedding page's afterglow, and
 * the duel's measure). Compared only while someone listens: a page that does not ask
 * pays nothing for it.
 */
function tellWrites(terminal: XTerm) {
  const listeners = new Set<(runs: Run[], written: number) => void>();
  let before: string[][] = [];
  terminal.onRender(() => {
    if (!listeners.size) return;
    const after = screenCells(terminal);
    const runs: Run[] = [];
    let written = 0;
    after.forEach((cells, row) => {
      const old = before[row] ?? [];
      let start = -1;
      for (let x = 0; x <= cells.length; x++) {
        const changed = x < cells.length && cells[x] !== old[x];
        if (changed) written++;
        if (changed && start < 0) start = x;
        if (!changed && start >= 0) {
          runs.push({ row, column: start, length: x - start });
          start = -1;
        }
      }
    });
    before = after;
    if (written) for (const listener of listeners) listener(runs, written);
  });
  return (listener: (runs: Run[], written: number) => void) => {
    if (!listeners.size) before = screenCells(terminal);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
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
    pixelScroll = true,
    path,
    grid,
    background,
    foreground,
  }: PageOptions,
) {
  const terminal = new XTerm({
    cursorBlink: true,
    allowProposedApi: true,
    fontFamily: FONTS,
    theme: {
      ...(background === undefined ? {} : { background: background }),
      ...(foreground === undefined ? {} : { foreground: foreground }),
    },
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(element);
  const gpu = attachTerminalView(terminal, { fallbackWheel: wheelReports(terminal) });
  // The page around the terminal, and the journeys that drive it, read the screen from
  // the buffer, not from the DOM: the GPU renderer draws nothing there, and the DOM
  // renderer stops drawing while a frame is out of view.
  exposeScreen(() => screenLines(terminal));
  exposeCells(() => screenCells(terminal));
  exposeWrites(tellWrites(terminal));
  exposeRenderer(gpu.renderer);
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
  let pixels: PixelController | undefined;
  const write = (data: string) => {
    pixels?.ordinary(data);
    return stdin.write(data);
  };
  const typed = control ? control.keys(write) : write;
  const ordinary = new OrdinaryPixelInput();
  terminal.onData((data) => {
    const replay = ordinary.convert(data);
    if (replay) tellTyped(replay);
    typed(data);
  });
  onInput(write);

  const session = restore
    ? pageSession(`luciole:session:${name}:${sessionKey ?? server.href}`)
    : forgotten;
  const app = create({
    url: server.href,
    ...definedProperties({ fetch: control?.fetch ?? fetch }),
    ...(control?.network === undefined ? {} : { network: control?.network }),
    ...(session.restored === undefined ? {} : { session: session.restored }),
    ...(path === undefined ? {} : { initialPath: path }),
    quitOnCtrlC: false,
  });
  app.onEvent(tellEvent);
  app.restoration.persistTo(session);
  addEventListener("pagehide", () => session.flush(app.restoration.snapshot()));

  const size = { columns: terminal.cols, rows: terminal.rows };
  const renderer = await createCliRenderer({
    stdin,
    stdout: terminalOutput(size, (chunk, done) => terminal.write(chunk, done)),
    width: size.columns,
    height: size.rows,
    exitOnCtrlC: false,
    exitSignals: [],
  });
  pixels = PixelController.attach(renderer, (commands) => terminal.write(commands), {
    pixelScroll,
  });
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
  // Output failures close the renderer independently of a voluntary quit.
  void renderer.closed.catch((error: unknown) => console.error(messageOf(error)));
  app.quit = () => {
    if (renderer.isDestroyed) return;
    session.remove();
    renderer.destroy();
    void renderer.closed.then(
      () => {
        terminal.write("\r\n\x1b[2mSession ended. Reload the page to start again.\x1b[0m\r\n");
      },
      () => {},
    );
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
  {
    name = "luciole",
    sessionKey,
    pixelScroll,
  }: { name?: string; sessionKey?: string; pixelScroll?: boolean } = {},
) {
  const element = document.getElementById("luciole");
  if (!element) throw new Error("The page has no #luciole element to run in");
  await runInPage(create, {
    element,
    server: new URL("/", location.href),
    name,
    ...(sessionKey === undefined ? {} : { sessionKey: sessionKey }),
    ...(pixelScroll === undefined ? {} : { pixelScroll }),
  });
}
