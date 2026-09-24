// Scripted fidelity: the same escape sequences fed to every emulator, the same assertion
// on the resulting cells, modes or answers. Each check runs on a fresh 40x10 instance.
// Outcome: "pass", "fail: <what was seen>", or "no API" when the emulator keeps the state
// but exposes no way to read it (which matters as much for an embedder).
import {
  EMULATORS,
  EMULATOR_NAMES,
  ghosttyWebShared,
  type Emulator,
  type EmulatorName,
} from "./emulators";
import { vtPattern } from "./gaps";

const COLS = 40;
const ROWS = 10;
const WRAP_COLS = 20;
const LONG_LINE = 30;
const URL = "https://airtty.dev/docs";
// Fixture geometry: rows L1–L5 of the scroll-region test, and the columns of each glyph.
const REGION_ROWS = 5;
const WIDE_COLUMNS = [0, 2, 2 * 2, 2 * 2 + 2];
const SGR_COLUMNS = [0, 1, 2, 2 + 1];
const PLAIN_COLUMN = "link ".length + 1;
// The SGR fixture's colors: palette index 196 is the cube's pure red.
const FULL = 0xff;
const RED: readonly number[] = [FULL, 0, 0];
const TRUECOLOR: readonly number[] = [1, 2, 2 + 1];
const DA1 = vtPattern(String.raw`^\e\[\?[\d;]+c$`);

type Grid = Awaited<ReturnType<Emulator["grid"]>>;
type Outcome = "pass" | "no API" | `fail: ${string}`;
const fail = (seen: unknown): Outcome => `fail: ${JSON.stringify(seen)}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function feed(term: Emulator, data: string) {
  term.write(data);
  await term.settle();
}
const lines = (grid: Grid, count: number) => Array.from({ length: count }, (_, y) => grid.line(y));

const CHECKS: Record<string, (term: Emulator) => Promise<Outcome>> = {
  "alt screen (1049) saves and restores the primary screen": async (term) => {
    await feed(term, "MAIN\r\n\x1b[?1049h\x1b[HALT");
    const inside = (await term.grid()).line(0);
    await feed(term, "\x1b[?1049l");
    const after = (await term.grid()).line(0);
    return inside === "ALT" && after === "MAIN" ? "pass" : fail({ inside, after });
  },
  "scroll region (DECSTBM) scrolls only its rows": async (term) => {
    await feed(
      term,
      "\x1b[1;1HL1\x1b[2;1HL2\x1b[3;1HL3\x1b[4;1HL4\x1b[5;1HL5\x1b[2;4r\x1b[4;1H\n\x1b[r",
    );
    const seen = lines(await term.grid(), REGION_ROWS);
    return same(seen, ["L1", "L3", "L4", "", "L5"]) ? "pass" : fail(seen);
  },
  "wide chars: CJK and emoji take two cells": async (term) => {
    await feed(term, "漢字👍x");
    const grid = await term.grid();
    const seen = WIDE_COLUMNS.map((x) => [grid.cell(x, 0)?.text, grid.cell(x, 0)?.width]);
    return same(seen, [
      ["漢", 2],
      ["字", 2],
      ["👍", 2],
      ["x", 1],
    ])
      ? "pass"
      : fail(seen);
  },
  "combining mark stays in its base cell": async (term) => {
    await feed(term, "éx");
    const grid = await term.grid();
    const seen = [grid.cell(0, 0)?.text.normalize("NFC"), grid.cell(1, 0)?.text];
    return same(seen, ["é", "x"]) ? "pass" : fail(seen);
  },
  // Legacy width (one cell per codepoint) stays the default; modern programs (OpenTUI
  // apps, fish, neovim) opt into grapheme clustering with mode 2027.
  "ZWJ emoji is one grapheme of width 2 once mode 2027 is on": async (term) => {
    await feed(term, "\x1b[?2027h👨‍👩‍👧x");
    const grid = await term.grid();
    const seen = [grid.cell(0, 0)?.text, grid.cell(2, 0)?.text];
    return same(seen, ["👨‍👩‍👧", "x"]) ? "pass" : fail(seen);
  },
  "SGR 256-color, truecolor, bold, inverse": async (term) => {
    await feed(term, "\x1b[38;5;196mR\x1b[38;2;1;2;3mT\x1b[0;1mB\x1b[0;7mI\x1b[0m");
    const grid = await term.grid();
    const [r, t, b, i] = SGR_COLUMNS.map((x) => grid.cell(x, 0));
    const seen = { r: r?.fg, t: t?.fg, bold: b?.bold, inverse: i?.inverse };
    return same(seen, { r: RED, t: TRUECOLOR, bold: true, inverse: true }) ? "pass" : fail(seen);
  },
  "mouse tracking 1000 + SGR 1006": async (term) => {
    await feed(term, "\x1b[?1000h\x1b[?1006h");
    const { mouse, sgrMouse } = await term.modes();
    if (mouse === undefined) return "no API";
    if (sgrMouse === undefined) return mouse ? "pass" : fail({ mouse });
    return mouse && sgrMouse ? "pass" : fail({ mouse, sgrMouse });
  },
  "bracketed paste (2004)": async (term) => {
    await feed(term, "\x1b[?2004h");
    const { bracketedPaste } = await term.modes();
    if (bracketedPaste === undefined) return "no API";
    return bracketedPaste ? "pass" : fail({ bracketedPaste });
  },
  "application cursor keys (DECCKM)": async (term) => {
    await feed(term, "\x1b[?1h");
    const { decckm } = await term.modes();
    if (decckm === undefined) return "no API";
    return decckm ? "pass" : fail({ decckm });
  },
  "cursor shape (DECSCUSR 5 = blinking bar)": async (term) => {
    await feed(term, "\x1b[5 q");
    const { cursorStyle } = await term.modes();
    if (cursorStyle === undefined) return "no API";
    return cursorStyle === "bar" || cursorStyle === "line" ? "pass" : fail({ cursorStyle });
  },
  "OSC 8 hyperlink on its cells": async (term) => {
    await feed(term, `\x1b]8;;${URL}\x1b\\link\x1b]8;;\x1b\\ plain`);
    const grid = await term.grid();
    const [on, off] = [grid.cell(0, 0), grid.cell(PLAIN_COLUMN, 0)];
    if (on?.link === undefined && off?.link === undefined)
      return on?.text === "l" ? "no API" : fail(on);
    return on?.link === URL && off?.link === undefined
      ? "pass"
      : fail({ on: on?.link, off: off?.link });
  },
  "answers DA1 (CSI c)": async (term) => {
    await feed(term, "\x1b[c");
    const answer = term.takeResponses();
    if (answer === undefined) return "no API";
    return DA1.test(answer) ? "pass" : fail(answer);
  },
  "answers DSR 6n with the cursor position": async (term) => {
    await feed(term, "ab\x1b[6n");
    const answer = term.takeResponses();
    if (answer === undefined) return "no API";
    return answer === "\x1b[1;3R" ? "pass" : fail(answer);
  },
  "answers OSC 11 background color query": async (term) => {
    await feed(term, "\x1b]11;?\x1b\\");
    const answer = term.takeResponses();
    if (answer === undefined) return "no API";
    return answer.startsWith("\x1b]11;rgb:") ? "pass" : fail(answer);
  },
  // The cursor stays on the wrapped line, as while typing a long command at a prompt.
  // xterm.js never reflows the cursor's line (it does once the cursor has left it).
  "reflows a wrapped line on resize": async (term) => {
    term.resize(WRAP_COLS, ROWS);
    await feed(term, "a".repeat(LONG_LINE));
    term.resize(COLS, ROWS);
    await term.settle();
    const seen = lines(await term.grid(), 2);
    return same(seen, ["a".repeat(LONG_LINE), ""]) ? "pass" : fail(seen);
  },
};

// A multiplexer frees and creates sessions all day: a new terminal must never show a
// previous one's cells (another origin's secrets, in airtty's case).
async function isolation(
  create: (cols: number, rows: number) => Promise<Emulator>,
): Promise<Outcome> {
  const first = await create(COLS, ROWS);
  await feed(first, "SECRET-FROM-A");
  await first.grid();
  first.dispose();
  const second = await create(COLS, ROWS);
  try {
    await feed(second, "B");
    const seen = (await second.grid()).line(0);
    return seen === "B" ? "pass" : fail(seen);
  } finally {
    second.dispose();
  }
}
const ISOLATION = "a new terminal never shows a freed terminal's cells";

export async function fidelity(names: readonly EmulatorName[] = EMULATOR_NAMES) {
  const results: Record<string, Record<string, Outcome>> = {};
  for (const name of names) {
    results[name] = {};
    for (const [check, run] of Object.entries(CHECKS)) {
      const term = await EMULATORS[name](COLS, ROWS);
      try {
        results[name][check] = await run(term);
      } catch (error: unknown) {
        results[name][check] = fail(error instanceof Error ? error.message : String(error));
      } finally {
        term.dispose();
      }
    }
    // ghostty-web is measured with one wasm instance per terminal (above); its documented
    // sharing of one instance is what this check exercises.
    const create = name === "ghostty-web" ? ghosttyWebShared : EMULATORS[name];
    results[name][ISOLATION] = await isolation(create).catch((error: unknown) =>
      fail(error instanceof Error ? error.message : String(error)),
    );
  }
  return results;
}

if (import.meta.main) {
  const results = await fidelity();
  for (const [name, checks] of Object.entries(results)) {
    const passed = Object.values(checks).filter((o) => o === "pass").length;
    console.log(`\n${name}: ${passed}/${Object.keys(checks).length}`);
    for (const [check, outcome] of Object.entries(checks))
      console.log(`  ${outcome === "pass" ? "✓" : "✗"} ${check}: ${outcome}`);
  }
}
