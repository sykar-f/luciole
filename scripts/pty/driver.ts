/**
 * Drives a program on a real pseudo-terminal and reads its screen, as a user would see it.
 *
 * The PTY is Bun's own (`Bun.Terminal`), the program spawned `detached` as in
 * packages/core/src/vt/pty.ts: it leads its own session, which is signaled as a whole
 * when the journey ends. The screen is rebuilt by OpenTUI's terminal emulator
 * (libghostty-vt, through `VtTerminalRenderable`) on a headless test renderer: the
 * emulator the VT widget shows programs with.
 *
 * What every journey needs is handled here once: the terminal queries OpenTUI sends at
 * startup are answered, waits only succeed on a complete synchronized-output frame, and a
 * failed wait reports what the screen showed.
 */
import { afterEach } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { messageOf } from "../../packages/core/src/guards";
import { VtTerminalRenderable } from "../../packages/core/src/vt/gaps";
import { environment } from "./harness";

const ESC = "\x1b";
/** Synchronized output (mode 2026): a frame starts with BEGIN and is complete at END. */
const FRAME_BEGIN = `${ESC}[?2026h`;
const FRAME_END = `${ESC}[?2026l`;
/**
 * The queries a Client waits on at startup, and a fixed answer for each: the cursor is at
 * the origin, the terminal a VT100 with advanced video. Nothing else is answered: the
 * emulator's own answers (kitty graphics, kitty keyboard, colors) would change what the
 * program chooses to draw, and a journey checks what a plain terminal gets.
 */
const QUERIES: ReadonlyArray<readonly [string, string]> = [
  [`${ESC}[6n`, `${ESC}[1;1R`],
  [`${ESC}[c`, `${ESC}[?1;2c`],
];
const LONGEST_QUERY = Math.max(...QUERIES.map(([query]) => query.length));
const POLL_MS = 20;
/**
 * How long a wait for the screen, or for the program to end, lasts unless told otherwise:
 * the guard against a hang, which says nothing of how fast the program should be. Under a
 * loaded host a startup, a request or an exit lands late; a bound taken on an idle machine
 * would then fail the machine, not the program. The suite's WAIT_MS (tests/helpers.ts).
 */
const HANG_MS = 30_000;
/** How long the program has to end on SIGTERM when the journey is done, before SIGKILL. */
const TERM_GRACE_MS = 5000;
/** How long a lone ESC waits before the next key, not to be read as Alt+key. */
const LONE_ESCAPE_MS = 300;
const FAILURE_OUTPUT_TAIL = 3000;
/**
 * After the program exits, output still in flight is read until the PTY is quiet this
 * long. The PTY's end of file cannot mark it: with a Bun program Bun.Terminal never
 * reports one.
 */
const DRAIN_QUIET_MS = 50;

/** Key sequences, as a terminal in its default modes sends them. */
export const Keys = {
  enter: "\r",
  tab: "\t",
  escape: ESC,
  backspace: "\x7f",
  up: `${ESC}[A`,
  down: `${ESC}[B`,
  ctrlDown: `${ESC}[1;5B`,
  pageDown: `${ESC}[6~`,
} as const;
const C0_MASK = 0x1f;
/** Ctrl+letter: the letter's code masked to the C0 range (Ctrl+C is 0x03). */
export const ctrl = (letter: string) =>
  String.fromCharCode(letter.toUpperCase().charCodeAt(0) & C0_MASK);
/** Bracketed paste, which is also how a terminal delivers dropped files. */
export const paste = (text: string) => `${ESC}[200~${text}${ESC}[201~`;
/** SGR mouse buttons. */
export const Mouse = { left: 0, right: 2 } as const;

/** The four termios flag words: equal before and after means the terminal was restored. */
type Attributes = readonly [number, number, number, number];

export type DriveOptions = {
  command: readonly string[];
  cols: number;
  rows: number;
  /** Added to this process's environment; `undefined` removes a variable. */
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** How long `type` waits after writing unless told otherwise, in ms. */
  settle?: number;
  /** How long a wait lasts unless told otherwise, in ms. */
  timeout?: number;
  /** How long the program has to end once asked to, in ms. */
  exitTimeout?: number;
};
export type WaitOptions = {
  timeout?: number;
  /** Wait until the needle is gone instead. */
  absent?: boolean;
};
export type Needle = string | RegExp | ((text: string) => boolean);
/** A run of cells with the same colors, as `#rrggbb`. */
export type Span = { text: string; fg: string; bg: string };

const describe = (needle: Needle) =>
  typeof needle === "function" ? "the expected screen" : JSON.stringify(String(needle));
const matches = (needle: Needle, text: string) =>
  typeof needle === "string"
    ? text.includes(needle)
    : needle instanceof RegExp
      ? needle.test(text)
      : needle(text);
const HEX = 16;
const hex = (ints: readonly number[]) =>
  "#" +
  ints
    .slice(0, 3)
    .map((value) => value.toString(HEX).padStart(2, "0"))
    .join("");

/**
 * The driver's waits still running. A test (tests/desktop.test.ts) that bun's timeout ends
 * before HANG_MS would leave its wait running, to throw later between other tests. After
 * each test, a wait still running prints what it would have reported under that test, then
 * stops where it stands, as `until` does in tests/helpers.ts.
 */
type Wait = { start: number; report: () => string; park: () => void };
const waiting = new Set<Wait>();
/** What a wait would have reported; a screen already gone says so instead of throwing. */
function reported(wait: Wait) {
  try {
    return wait.report();
  } catch (error: unknown) {
    return `report unavailable: ${messageOf(error)}`;
  }
}
try {
  afterEach(() => {
    for (const wait of waiting) {
      const ms = Math.round(performance.now() - wait.start);
      console.error(`The test ended while a PTY wait still ran, after ${ms} ms: ${reported(wait)}`);
      wait.park();
    }
    waiting.clear();
  });
} catch {
  // Outside bun test (bun scripts/pty/*.ts): no test ends a wait.
}
/** A wait to watch; `parked` resolves once the test that started it has ended. */
function watched(report: () => string) {
  let park = () => {};
  const parked = new Promise<"parked">((done) => (park = () => done("parked")));
  const wait = { start: performance.now(), report, park };
  waiting.add(wait);
  return { parked, done: () => waiting.delete(wait) };
}
/** Never settles: what an abandoned test would run after its wait never runs. */
const abandoned = () => new Promise<never>(() => {});

/** The screen a terminal shows for the bytes it was given. */
class Screen {
  private dirty = true;
  private rendering = Promise.resolve();
  private readonly setup: TestRendererSetup;
  private readonly vt: VtTerminalRenderable;
  cols: number;
  rows: number;
  private constructor(
    setup: TestRendererSetup,
    vt: VtTerminalRenderable,
    cols: number,
    rows: number,
  ) {
    this.setup = setup;
    this.vt = vt;
    this.cols = cols;
    this.rows = rows;
  }
  static async open(cols: number, rows: number) {
    const setup = await createTestRenderer({ width: cols, height: rows });
    // Its own answers are never sent back (see QUERIES), so no onData.
    const vt = new VtTerminalRenderable(setup.renderer, { width: "100%", height: "100%" });
    setup.renderer.root.add(vt);
    const screen = new Screen(setup, vt, cols, rows);
    await screen.refresh();
    return screen;
  }
  feed(bytes: Uint8Array | string) {
    this.vt.write(bytes);
    this.dirty = true;
  }
  /** Brings `lines` and `spans` up to date: the emulator's grid is read at render time. */
  refresh() {
    this.rendering = this.rendering.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      await this.setup.renderOnce();
    });
    return this.rendering;
  }
  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.setup.resize(cols, rows);
    this.dirty = true;
  }
  /** Every row, padded to the width, as a terminal shows it. */
  lines() {
    const { lines } = this.vt.screen();
    return Array.from({ length: this.rows }, (_, row) => (lines[row] ?? "").padEnd(this.cols));
  }
  spans(): Span[][] {
    return this.setup.captureSpans().lines.map((line) =>
      line.spans.map((span) => ({
        text: span.text,
        fg: hex(span.fg.toInts()),
        bg: hex(span.bg.toInts()),
      })),
    );
  }
  destroy() {
    this.setup.renderer.destroy();
  }
}

/** A program on its own PTY, its output parsed into a screen. */
export class Driver implements AsyncDisposable {
  private raw = "";
  private lastOutput = performance.now();
  /** Where `output` starts. */
  private outputMark = 0;
  /** How much output there was when the last input was written. */
  private inputMark?: number;
  private carry = "";
  /** The program exited and its last output was read. */
  private readonly drained: Promise<void>;
  private readonly decoder = new TextDecoder();
  private readonly settle: number;
  private readonly timeout: number;
  private readonly exitTimeout: number;
  private readonly terminal: Bun.Terminal;
  private readonly child: Bun.Subprocess;
  private readonly screen: Screen;
  /** The PTY's attributes before the program started. */
  private readonly before: Attributes;
  private constructor(
    parts: { terminal: Bun.Terminal; child: Bun.Subprocess; screen: Screen; before: Attributes },
    options: DriveOptions,
  ) {
    ({
      terminal: this.terminal,
      child: this.child,
      screen: this.screen,
      before: this.before,
    } = parts);
    this.settle = options.settle ?? 0;
    this.timeout = options.timeout ?? HANG_MS;
    this.exitTimeout = options.exitTimeout ?? HANG_MS;
    this.drained = this.child.exited.then(async () => {
      while (performance.now() - this.lastOutput < DRAIN_QUIET_MS) await Bun.sleep(POLL_MS);
    });
  }

  static async start(options: DriveOptions): Promise<Driver> {
    const screen = await Screen.open(options.cols, options.rows);
    let driver: Driver | undefined;
    const pending: Uint8Array[] = [];
    const terminal = new Bun.Terminal({
      cols: options.cols,
      rows: options.rows,
      name: "xterm-256color",
      data: (_terminal, bytes) => (driver ? driver.receive(bytes) : pending.push(bytes)),
    });
    const before = attributesOf(terminal);
    const child = Bun.spawn([...options.command], {
      terminal,
      detached: true,
      cwd: options.cwd,
      env: environment({ TERM: "xterm-256color", ...options.env }),
    });
    driver = new Driver({ terminal, child, screen, before }, options);
    for (const bytes of pending) driver.receive(bytes);
    return driver;
  }

  get pid() {
    return this.child.pid;
  }
  get running() {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  private receive(bytes: Uint8Array) {
    this.lastOutput = performance.now();
    const text = this.decoder.decode(bytes, { stream: true });
    this.answer(text);
    this.raw += text;
    this.screen.feed(bytes);
  }
  private answer(text: string) {
    const scanned = this.carry + text;
    for (const [query, reply] of QUERIES) {
      // Counted from the carried tail on, so that a query is answered once.
      let at = scanned.indexOf(query);
      while (at >= 0) {
        if (at + query.length > this.carry.length) this.send(reply);
        at = scanned.indexOf(query, at + 1);
      }
    }
    this.carry = scanned.slice(-(LONGEST_QUERY - 1));
  }

  private send(data: string | Uint8Array) {
    if (!this.terminal.closed) this.terminal.write(data);
  }
  /** Input, as typed: from now on, waits need a frame drawn after it. */
  write(data: string | Uint8Array) {
    this.inputMark = this.raw.length;
    this.send(data);
  }
  /** Writes keys, then lets the program react for `settle` ms. */
  async type(data: string, settle = this.settle) {
    this.write(data);
    if (settle > 0) await Bun.sleep(settle);
  }
  /** A lone ESC: the next key must not follow at once, or it reads as Alt+key. */
  escape(settle = LONE_ESCAPE_MS) {
    return this.type(Keys.escape, settle);
  }
  /** Presses then releases a mouse button on the first cell of `text` (SGR, 1-based). */
  async click(text: string, button: number = Mouse.left) {
    const lines = await this.lines();
    const row = lines.findIndex((line) => line.includes(text));
    if (row < 0) throw this.failure(`nothing to click: ${JSON.stringify(text)} is not shown`);
    const column = (lines[row] ?? "").indexOf(text);
    for (const final of ["M", "m"])
      this.write(`${ESC}[<${button};${column + 1};${row + 1}${final}`);
    if (this.settle > 0) await Bun.sleep(this.settle);
  }

  /** What the screen shows, every row padded to the width. */
  async lines() {
    await this.screen.refresh();
    return this.screen.lines();
  }
  async text() {
    return (await this.lines()).join("\n");
  }
  /** Each row's runs of equally colored cells. */
  async spans() {
    await this.screen.refresh();
    return this.screen.spans();
  }
  /** The colors at `column` (an index into the row's text) of `row`. */
  async styleAt(row: number, column: number) {
    let start = 0;
    for (const span of (await this.spans())[row] ?? []) {
      if (column < start + span.text.length) return span;
      start += span.text.length;
    }
    throw new Error(`no cell at row ${row}, column ${column}`);
  }
  /** The screen as a text capture: trailing blanks trimmed, one final newline. */
  async snapshot() {
    return (
      (await this.lines())
        .map((line) => line.trimEnd())
        .join("\n")
        .trimEnd() + "\n"
    );
  }
  /** Clears the screen, as for a new program taking over the terminal. */
  resetScreen() {
    this.screen.feed(`${ESC}c`);
  }

  /** From now on, `output` only returns what the program writes after this point. */
  markOutput() {
    this.outputMark = this.raw.length;
  }
  /** What the program wrote since the last mark, escape sequences included. */
  output() {
    return this.raw.slice(this.outputMark);
  }
  /**
   * For a program that draws with synchronized output: no frame is half drawn, and one
   * ended after the last input, so that the screen is not the one from before a key.
   */
  private frameComplete() {
    const begin = this.raw.lastIndexOf(FRAME_BEGIN);
    if (begin < 0) return true;
    const end = this.raw.lastIndexOf(FRAME_END);
    return end > begin && (this.inputMark === undefined || end >= this.inputMark);
  }

  /**
   * Waits until the screen shows `needle` (or no longer does, with `absent`) at the end of
   * a complete frame drawn after the last input. Returns when it did, from
   * performance.now().
   */
  async waitFor(needle: Needle, options: WaitOptions = {}) {
    const deadline = performance.now() + (options.timeout ?? this.timeout);
    const what = `${options.absent ? "the screen kept" : "the screen never showed"} ${describe(needle)}`;
    const wait = watched(() => this.failure(what).message);
    try {
      for (;;) {
        const now = performance.now();
        if (this.frameComplete() && matches(needle, await this.text()) !== Boolean(options.absent))
          return now;
        if (now > deadline) throw this.failure(what, await this.text());
        if ((await Promise.race([Bun.sleep(POLL_MS), wait.parked])) === "parked")
          return abandoned();
      }
    } finally {
      wait.done();
    }
  }
  /** Lets the program run for `ms`, its output still read and answered. */
  pause(ms: number) {
    return Bun.sleep(ms);
  }
  private failure(message: string, screen?: string) {
    const shown = screen ?? this.screen.lines().join("\n");
    const tail = JSON.stringify(this.raw.slice(-FAILURE_OUTPUT_TAIL));
    return new Error(`${message}\n--- screen\n${shown}\n--- last output\n${tail}`);
  }

  /**
   * The PTY's new size. The kernel sends SIGWINCH to the terminal's foreground group, but a
   * Bun program spawned by Bun ends up without the PTY as its controlling terminal (ps
   * shows none): the program is told directly too.
   */
  resize(cols: number, rows: number) {
    this.terminal.resize(cols, rows);
    this.screen.resize(cols, rows);
    this.signal("SIGWINCH");
  }
  /** Sends a signal to the program itself. */
  signal(signal: NodeJS.Signals) {
    if (this.running) this.child.kill(signal);
  }
  /** Closing a terminal window: every process of the session gets SIGHUP. */
  hangup() {
    this.signalGroup("SIGHUP");
  }
  private signalGroup(signal: NodeJS.Signals) {
    try {
      // detached: the program leads its own process group.
      process.kill(-this.child.pid, signal);
    } catch {}
  }
  /** Waits for the program to end and its output to be read; its exit status (null for a signal). */
  async exited(timeout = this.exitTimeout) {
    const wait = watched(() => this.failure("the program is still running").message);
    // Cleared once the wait ends: a pending guard would keep a finished journey alive.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const done = await Promise.race([
        this.drained.then(() => true),
        new Promise<false>((late) => (timer = setTimeout(() => late(false), timeout))),
        wait.parked,
      ]);
      if (done === "parked") return abandoned();
      if (!done) throw this.failure(`the program is still running after ${timeout} ms`);
      return this.child.exitCode;
    } finally {
      clearTimeout(timer);
      wait.done();
    }
  }
  /** Fails unless the termios flags are those the PTY had before the program started. */
  assertRestored() {
    const after = attributesOf(this.terminal);
    if (after.some((flags, index) => flags !== this.before[index]))
      throw new Error(`terminal attributes not restored: ${this.before.join()} -> ${after.join()}`);
  }
  /**
   * Ends the program as a user would (Ctrl+C by default), then checks it exited with 0
   * and gave the terminal back as it found it.
   */
  async quit(keys = ctrl("c"), timeout = this.exitTimeout) {
    this.write(keys);
    const code = await this.exited(timeout);
    if (code !== 0) throw this.failure(`exit status ${code}, expected 0`);
    this.assertRestored();
  }

  /** Stops what is left of the program's session, then frees the PTY and the screen. */
  async [Symbol.asyncDispose]() {
    if (this.running) {
      this.signalGroup("SIGTERM");
      if (!(await Promise.race([this.child.exited.then(() => true), Bun.sleep(TERM_GRACE_MS)])))
        this.signalGroup("SIGKILL");
      await this.child.exited;
    }
    this.terminal.close();
    this.screen.destroy();
  }
}

function attributesOf(terminal: Bun.Terminal): Attributes {
  return [terminal.inputFlags, terminal.outputFlags, terminal.localFlags, terminal.controlFlags];
}

/** Starts `options.command` on a new PTY; `await using` stops it at the end of the scope. */
export const drive = (options: DriveOptions) => Driver.start(options);
