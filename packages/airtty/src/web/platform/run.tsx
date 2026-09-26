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
import { embedded, onInput, stage, type Grid, type Look } from "../embed";

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
} & Look;

const SAVE_DELAY_MS = 200;
/** What terminals draw with, before a generic monospace. */
const FONTS =
  'ui-monospace, "SF Mono", Menlo, "Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace';
const LARGEST_FONT = 24;
const SMALLEST_FONT = 4;
const FONT_STEP = 0.25;

/** The largest font at which `grid` fits the element, then exactly that grid. */
function fitGrid(terminal: XTerm, fit: FitAddon, grid: Grid) {
  for (let size = LARGEST_FONT; size >= SMALLEST_FONT; size -= FONT_STEP) {
    terminal.options.fontSize = size;
    const room = fit.proposeDimensions();
    if (room && room.cols >= grid.columns && room.rows >= grid.rows) break;
  }
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

export async function runInPage(
  create: (options: RunOptions) => Application,
  { element, server, fetch, name, sessionKey, grid, background, foreground }: PageOptions,
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
  const layout = () => (grid ? fitGrid(terminal, fit, grid) : fit.fit());
  layout();
  // In a page of its own, the terminal is what the reader came for. Framed, a focus
  // would scroll the embedding page to it: the reader clicks it instead.
  if (!embedded) terminal.focus();
  const stdin = new PassThrough();
  if (!isInputStream(stdin)) throw new Error("unreachable: a PassThrough is readable");
  terminal.onData((data) => stdin.write(data));
  onInput((data) => stdin.write(data));

  const session = pageSession(`airtty:session:${name}:${sessionKey ?? server.href}`);
  const app = create({
    url: server.href,
    fetch,
    session: session.restored,
    quitOnCtrlC: false,
  });
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
 * The terminal's contract in a page: the element `#airtty`, the Server on this origin.
 * `runInPage` takes both explicitly.
 */
export async function run(
  create: (options: RunOptions) => Application,
  { name = "airtty", sessionKey }: { name?: string; sessionKey?: string } = {},
) {
  const element = document.getElementById("airtty");
  if (!element) throw new Error("The page has no #airtty element to run in");
  await runInPage(create, { element, server: new URL("/", location.href), name, sessionKey });
}
