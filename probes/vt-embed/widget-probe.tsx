/** @jsxImportSource @opentui/react */
// Headless proof of <VtView>: a real shell and a real vim on real PTYs, driven through
// OpenTUI's mock keyboard and mouse, asserted on the composed frame and on the bytes that
// cross the PTY. Run: `bun widget-probe.tsx` (merges its section into results.json).
import { act, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import { useKeyboard } from "@opentui/react";
import type { EmbeddedTerminalRenderable } from "@opentui/core";
import { VtView, type VtTraffic } from "./vt-view";
import type { Pty } from "./pty";
import { vtPattern } from "./gaps";
import { saveSection } from "./results";

const WIDTH = 100;
const HEIGHT = 20;
const WIDE = 140;
const TALL = 30;
const TIMEOUT_MS = 8000;
const POLL_MS = 10;
const SETTLE_MS = 150;
const SEQ_LINES = 100_000;
const SIGINT_STATUS = 130;
const MB = 1e6;
const MS_PER_S = 1000;
// Where the mouse test clicks, in cells from the view's origin (SGR reports are 1-based).
const CLICK_COL = 3;
const CLICK_ROW = 2;
const SGR_PRESS = `\x1b[<0;${CLICK_COL + 1};${CLICK_ROW + 1}M`;
const SGR_RELEASE = `\x1b[<0;${CLICK_COL + 1};${CLICK_ROW + 1}m`;
// vim's empty buffer shows `~` on every line past the text.
const VIM_TILDES = 3;
const CTRL_O = 0x0f;
const DA1_ANSWER = vtPattern(String.raw`\e\[\?62;22c`);
const DA2_ANSWER = vtPattern(String.raw`\e\[>1;10;0c`);
const DSR_ANSWER = vtPattern(String.raw`\e\[\d+;\d+R`);
// The shell every scenario runs: no rc file, a fixed prompt, so frames are predictable.
const SHELL = ["/bin/sh", "-i"];
const SHELL_ENV = { PS1: "$ ", ENV: undefined, HISTFILE: "/dev/null" };

const results: Record<string, unknown> = {};
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results[name] = detail === undefined ? ok : { ok, detail };
  if (!ok) failures.push(name);
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`,
  );
}
const decoder = new TextDecoder();
// The views draw a border: predicates read the terminal's cells, not the chrome.
const clean = (frame: string) => frame.replaceAll("│", "");
const text = (bytes: readonly Uint8Array[]) => bytes.map((b) => decoder.decode(b)).join("");

type Session = {
  view: EmbeddedTerminalRenderable;
  pty: Pty;
  traffic: Record<VtTraffic, Uint8Array[]>;
};
function session() {
  const traffic: Record<VtTraffic, Uint8Array[]> = { output: [], input: [], response: [] };
  let ready: Session | undefined;
  return {
    traffic,
    onTraffic: (source: VtTraffic, bytes: Uint8Array) => traffic[source].push(bytes.slice()),
    onReady: (view: EmbeddedTerminalRenderable, pty: Pty) => {
      ready = { view, pty, traffic };
    },
    get: () => {
      if (!ready) throw new Error("session not ready");
      return ready;
    },
    ready: () => ready !== undefined,
  };
}

// ---------------------------------------------------------------------------------------
// Scenario 1: one shell, then vim, in one focused view.
const one = session();
const ui = await testRender(
  <VtView
    id="term"
    argv={SHELL}
    env={SHELL_ENV}
    cwd={import.meta.dir}
    focused
    width="100%"
    height="100%"
    onTraffic={one.onTraffic}
    onReady={one.onReady}
  />,
  { width: WIDTH, height: HEIGHT, exitOnCtrlC: false },
);
async function waitFrame(what: string, predicate: (frame: string) => boolean) {
  const start = performance.now();
  for (;;) {
    let frame = "";
    await act(async () => {
      await ui.renderOnce();
      frame = clean(ui.captureCharFrame());
    });
    if (predicate(frame)) return performance.now() - start;
    if (performance.now() - start > TIMEOUT_MS) throw new Error(`timeout: ${what}\n${frame}`);
    await Bun.sleep(POLL_MS);
  }
}
async function type(line: string) {
  await act(async () => {
    await ui.mockInput.typeText(line);
    ui.mockInput.pressEnter();
  });
}
// ESC-prefixed keys reach the renderable only after the input parser's ESC timeout.
const KEY_SETTLE_MS = 60;
/** Keys pressed while the view has focus, and the bytes the emulator encoded for them. */
async function encoded(press: () => void) {
  const before = one.traffic.input.length;
  await act(async () => {
    press();
    await Bun.sleep(KEY_SETTLE_MS);
  });
  return text(one.traffic.input.slice(before));
}
const lastPrompt = (frame: string) => frame.split("\n").some((l) => l.trim() === "$");

try {
  await waitFrame("PTY spawned on first layout", () => one.ready());
  const { view, pty } = one.get();
  check(
    "pty size = inner box size (border excluded)",
    view.width === WIDTH - 2 && view.height === HEIGHT - 2,
    {
      cols: view.width,
      rows: view.height,
    },
  );
  await waitFrame("prompt", lastPrompt);
  check(
    "no 'no job control' warning (detached: setsid + controlling tty)",
    !clean(ui.captureCharFrame()).includes("job control"),
  );

  const typed = performance.now();
  await act(async () => ui.mockInput.typeText("echo hi"));
  const echoMs = await waitFrame("echo of typed text", (f) => f.includes("$ echo hi"));
  await act(async () => ui.mockInput.pressEnter());
  await waitFrame("command output", (f) => /^hi\s*$/m.test(f));
  check("typed text echoes, command runs", true, {
    keyToEchoMs: Math.round(performance.now() - typed),
    echoMs: Math.round(echoMs),
  });

  // Key encoding, normal modes. Sent to the shell's line editor, then discarded with ^U.
  const keys = {
    "ctrl-a": await encoded(() => ui.mockInput.pressKey("a", { ctrl: true })),
    "alt-x": await encoded(() => ui.mockInput.pressKey("x", { meta: true })),
    up: await encoded(() => ui.mockInput.pressArrow("up")),
    f1: await encoded(() => ui.mockInput.pressKey("F1")),
    f5: await encoded(() => ui.mockInput.pressKey("F5")),
    tab: await encoded(() => ui.mockInput.pressTab()),
    backspace: await encoded(() => ui.mockInput.pressBackspace()),
    enter: await encoded(() => ui.mockInput.pressEnter()),
  };
  check(
    "key encoding (normal mode)",
    keys["ctrl-a"] === "\x01" &&
      keys["alt-x"] === "\x1bx" &&
      keys.up === "\x1b[A" &&
      keys.f1 === "\x1bOP" &&
      keys.f5 === "\x1b[15~" &&
      keys.tab === "\t" &&
      keys.backspace === "\x7f" &&
      keys.enter === "\r",
    keys,
  );
  await waitFrame("prompt after keys", lastPrompt);

  // DECCKM: the program asks for application cursor keys; the encoder follows the mode.
  await type("printf '\\033[?1h'; echo decckm-on");
  await waitFrame("decckm on", (f) => /^decckm-on/m.test(f));
  const appUp = await encoded(() => ui.mockInput.pressArrow("up"));
  await act(async () => ui.mockInput.pressKey("u", { ctrl: true }));
  await type("printf '\\033[?1l'; echo decckm-off");
  await waitFrame("decckm off", (f) => /^decckm-off/m.test(f));
  check("DECCKM switches arrows to SS3 (ESC O A)", appUp === "\x1bOA", appUp);

  // Bracketed paste: wrapped only once the program enables mode 2004.
  const plainPaste = await encoded(() => void ui.mockInput.pasteBracketedText("p1"));
  await act(async () => ui.mockInput.pressKey("u", { ctrl: true }));
  await type("printf '\\033[?2004h'; echo bp-on");
  await waitFrame("bp on", (f) => /^bp-on/m.test(f));
  const wrappedPaste = await encoded(() => void ui.mockInput.pasteBracketedText("p2"));
  await act(async () => ui.mockInput.pressKey("u", { ctrl: true }));
  await type("printf '\\033[?2004l'; echo bp-off");
  await waitFrame("bp off", (f) => /^bp-off/m.test(f));
  check(
    "bracketed paste follows mode 2004",
    plainPaste === "p1" && wrappedPaste === "\x1b[200~p2\x1b[201~",
    {
      plainPaste,
      wrappedPaste,
    },
  );

  // Mouse: nothing is forwarded until the program asks (1000 + SGR 1006).
  const x = view.x + CLICK_COL;
  const y = view.y + CLICK_ROW;
  const idleClick = await encoded(() => void ui.mockMouse.click(x, y));
  await type("printf '\\033[?1000h\\033[?1006h'; echo mouse-on");
  await waitFrame("mouse on", (f) => /^mouse-on/m.test(f));
  const before = one.traffic.input.length;
  await act(async () => {
    await ui.mockMouse.click(x, y);
  });
  const sgrClick = text(one.traffic.input.slice(before));
  // One early run (before the ESC settle delay above) saw the release reported twice;
  // not reproduced since. Counted, so that a regression shows in results.json.
  const releases = sgrClick.split(SGR_RELEASE).length - 1;
  await act(async () => ui.mockInput.pressKey("u", { ctrl: true }));
  await type("printf '\\033[?1000l\\033[?1006l'; echo mouse-off");
  await waitFrame("mouse off", (f) => /^mouse-off/m.test(f));
  check(
    "mouse: silent by default, SGR 1006 once enabled (cell coords are view-local, 1-based)",
    idleClick === "" && sgrClick.startsWith(SGR_PRESS + SGR_RELEASE),
    {
      idleClick,
      sgrClick,
      releases,
    },
  );

  // Queries: DA1 and DSR 6n are answered by the emulator, on the "response" channel.
  const responses = one.traffic.response.length;
  await type("printf '\\033[c\\033[>c\\033]11;?\\007\\033[6n'; sleep 0.2; echo; echo queried");
  await waitFrame("queried", (f) => /^queried/m.test(f));
  const answers = text(one.traffic.response.slice(responses));
  check(
    "DA1, DA2, OSC 11 (gaps.ts) and DSR (native) answered to the PTY",
    DA1_ANSWER.test(answers) &&
      DA2_ANSWER.test(answers) &&
      answers.includes("\x1b]11;rgb:0000/0000/0000\x07") &&
      DSR_ANSWER.test(answers),
    answers,
  );
  await act(async () => ui.mockInput.pressKey("u", { ctrl: true }));
  await act(async () => ui.mockInput.pressEnter());

  // Job control: Ctrl-C interrupts the foreground job, not the shell.
  await type("sleep 30");
  await Bun.sleep(SETTLE_MS);
  await act(async () => ui.mockInput.pressKey("c", { ctrl: true }));
  await type("echo status=$?");
  await waitFrame("sleep interrupted", (f) => f.includes(`status=${SIGINT_STATUS}`));
  check("Ctrl-C interrupts the foreground job (status 130)", true);

  // Resize: layout → emulator → TIOCSWINSZ → SIGWINCH; `stty size` reads the kernel's view.
  await act(async () => ui.resize(WIDE, TALL));
  await waitFrame("relayout", () => view.width === WIDE - 2);
  await type("stty size");
  await waitFrame("stty size", (f) => f.includes(`${TALL - 2} ${WIDE - 2}`));
  check("resize reaches the program (stty size)", true, { cols: view.width, rows: view.height });

  // Throughput through the whole path (PTY → libghostty → frame), rendering while it runs.
  await type("clear");
  const seqStart = performance.now();
  const outputBefore = one.traffic.output.reduce((n, b) => n + b.byteLength, 0);
  await type(`seq 1 ${SEQ_LINES}; echo seq-done`);
  await waitFrame("seq", (f) => /^seq-done/m.test(f));
  const seqMs = performance.now() - seqStart;
  const seqBytes = one.traffic.output.reduce((n, b) => n + b.byteLength, 0) - outputBefore;
  check("seq 1..100000 through the widget", true, {
    ms: Math.round(seqMs),
    bytes: seqBytes,
    mbPerS: Number((seqBytes / MB / (seqMs / MS_PER_S)).toFixed(1)),
  });

  // vim on the alternate screen, then back to the shell's screen.
  await type("clear; echo before-vim");
  await waitFrame("before vim", (f) => /^before-vim/m.test(f));
  await type("vim -u NONE -N -i NONE");
  const vimMs = await waitFrame(
    "vim screen",
    (f) => f.split("\n").filter((l) => l.startsWith("~")).length > VIM_TILDES,
  );
  await act(async () => ui.mockInput.typeText("ihello from vim"));
  await act(async () => ui.mockInput.pressEscape());
  // A lone ESC is ambiguous (Alt prefix, CSI start): the input parser resolves it after
  // a timeout, so wait for vim to leave insert mode before typing the command.
  await waitFrame(
    "vim normal mode",
    (f) => f.includes("hello from vim") && !f.includes("-- INSERT --"),
  );
  await type(":q!");
  await waitFrame("back to shell", (f) => /^before-vim/m.test(f) && !f.includes("hello from vim"));
  check("vim: alt screen, insert, :q! restores the shell screen", true, {
    vimStartMs: Math.round(vimMs),
  });
  // An OpenTUI program (an airtty Client in `process` mode) inside the view: it probes the
  // terminal at startup, takes keys through the emulator, and gives the screen back.
  await type("clear; bun child-opentui.tsx");
  const childMs = await waitFrame("opentui child", (f) => f.includes("opentui child ready"));
  await act(async () => ui.mockInput.pressKey("x"));
  await waitFrame("child key", (f) => f.includes("keys: x"));
  await act(async () => ui.mockInput.pressKey("q"));
  await waitFrame("child quit", (f) => !f.includes("opentui child ready") && lastPrompt(f));
  check("OpenTUI child: starts, receives keys, restores the shell", true, {
    startupMs: Math.round(childMs),
  });
  await type("exit");
  check(
    "shell exits",
    (await Promise.race([pty.exited, Bun.sleep(TIMEOUT_MS).then(() => "timeout")])) === 0,
  );
} finally {
  await act(async () => ui.renderer.destroy());
}

// ---------------------------------------------------------------------------------------
// Scenario 2: two views side by side; Ctrl-O, caught by the host before the focused
// view, moves the focus. Proves that the host keeps a prefix key without a keymap layer.
const left = session();
const right = session();
function Split() {
  const [focus, setFocus] = useState<"left" | "right">("left");
  useKeyboard((key) => {
    if (!key.ctrl || key.name !== "o") return;
    // Global listeners run before the focused renderable; preventDefault() keeps ^O
    // out of the PTY (InternalKeyHandler.emitWithPriority, @opentui/core 0.5.12).
    key.preventDefault();
    setFocus((f) => (f === "left" ? "right" : "left"));
  });
  return (
    <box flexDirection="row" width="100%" height="100%">
      <VtView
        id="left"
        argv={SHELL}
        env={SHELL_ENV}
        focused={focus === "left"}
        flexGrow={1}
        onTraffic={left.onTraffic}
        onReady={left.onReady}
      />
      <VtView
        id="right"
        argv={SHELL}
        env={SHELL_ENV}
        focused={focus === "right"}
        flexGrow={1}
        onTraffic={right.onTraffic}
        onReady={right.onReady}
      />
    </box>
  );
}
const split = await testRender(<Split />, { width: WIDTH, height: HEIGHT, exitOnCtrlC: false });
const half = (frame: string, side: "left" | "right") =>
  frame
    .split("\n")
    .map((l) => (side === "left" ? l.slice(0, WIDTH / 2) : l.slice(WIDTH / 2)))
    .join("\n")
    .replaceAll("│", "");
async function splitFrame(predicate: (frame: string) => boolean) {
  const start = performance.now();
  for (;;) {
    let frame = "";
    await act(async () => {
      await split.renderOnce();
      frame = split.captureCharFrame();
    });
    if (predicate(frame)) return frame;
    if (performance.now() - start > TIMEOUT_MS) throw new Error(`timeout (split)\n${frame}`);
    await Bun.sleep(POLL_MS);
  }
}
try {
  await splitFrame(
    (f) =>
      left.ready() && right.ready() && lastPrompt(half(f, "left")) && lastPrompt(half(f, "right")),
  );
  await act(async () => {
    await split.mockInput.typeText("echo LEFT");
    split.mockInput.pressEnter();
  });
  await act(async () => split.mockInput.pressKey("o", { ctrl: true }));
  await act(async () => {
    await split.mockInput.typeText("echo RIGHT");
    split.mockInput.pressEnter();
  });
  const frame = await splitFrame(
    (f) => /^LEFT/m.test(half(f, "left")) && /^RIGHT/m.test(half(f, "right")),
  );
  const leakedCtrlO = [...left.traffic.input, ...right.traffic.input].some((b) =>
    b.includes(CTRL_O),
  );
  check(
    "split: Ctrl-O moves focus, each view gets its own keys, ^O never reaches a PTY",
    !half(frame, "left").includes("RIGHT") &&
      !half(frame, "right").includes("LEFT") &&
      !leakedCtrlO,
  );
  left.get().pty.write("exit\n");
  right.get().pty.write("exit\n");
} finally {
  await act(async () => split.renderer.destroy());
}

await saveSection("widget", { results });
if (failures.length) {
  console.error(`${failures.length} failure(s): ${failures.join(", ")}`);
  process.exit(1);
}
process.exit(0);
