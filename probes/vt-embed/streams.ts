// The byte streams the emulators are measured on. Three are recorded from real programs
// on a real PTY (what an embedded shell, `ls` and vim actually emit), one is synthetic
// (a colored application log with 256-color, truecolor, CJK and emoji). Recorded once
// into .out/streams/ and reused, so every emulator parses exactly the same bytes.
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnPty } from "./pty";

export const STREAM_COLS = 120;
export const STREAM_ROWS = 40;
const OUT = join(import.meta.dir, ".out", "streams");
const REPO = resolve(import.meta.dir, "../..");
const SEQ_LINES = 200_000;
const LOG_LINES = 20_000;
const VIM_PAGES = 40;
const VIM_STEP_MS = 15;
const VIM_START_MS = 400;
const RECORD_TIMEOUT_MS = 30_000;

export type StreamName = "seq" | "ls-color" | "vim" | "ansi-log";
export const STREAM_NAMES: readonly StreamName[] = ["seq", "ls-color", "vim", "ansi-log"];

async function record(
  argv: readonly string[],
  drive?: (write: (s: string) => void) => Promise<void>,
) {
  const chunks: Uint8Array[] = [];
  const pty = spawnPty({
    argv,
    cols: STREAM_COLS,
    rows: STREAM_ROWS,
    cwd: REPO,
    onData: (bytes) => chunks.push(bytes.slice()),
  });
  if (drive) await drive((s) => pty.write(s));
  const timeout = Bun.sleep(RECORD_TIMEOUT_MS).then(() => {
    pty.kill("SIGKILL");
    throw new Error(`recording ${argv.join(" ")} timed out`);
  });
  await Promise.race([pty.exited, timeout]);
  return Buffer.concat(chunks);
}

// Deterministic pseudo-random numbers (the ANSI C LCG): the synthetic log is identical on
// every run.
const LCG_MULTIPLIER = 1_103_515_245;
const LCG_INCREMENT = 12_345;
const LCG_MODULUS = 2_147_483_648;
const LOG_SEED = 42;
const LOG_EPOCH = Date.parse("2026-09-24T00:00:00Z");
function lcg(seed: number) {
  let state = seed;
  return (n: number) => {
    state = (state * LCG_MULTIPLIER + LCG_INCREMENT) % LCG_MODULUS;
    return state % n;
  };
}
const WORDS = [
  "request",
  "cache",
  "flight",
  "render",
  "route",
  "commit",
  "漢字",
  "résumé",
  "👍",
  "naïve",
];
const LEVELS = [
  "\x1b[1;32mINFO \x1b[0m",
  "\x1b[1;33mWARN \x1b[0m",
  "\x1b[1;31mERROR\x1b[0m",
  "\x1b[2mDEBUG\x1b[0m",
];
const PALETTE_SIZE = 256;
const CHANNEL = 256;
const MS_PER_LINE = 7;
const MODULE_WIDTH = 12;
const MESSAGE_WORDS = 12;
function ansiLog() {
  const random = lcg(LOG_SEED);
  let out = "";
  for (let i = 0; i < LOG_LINES; i++) {
    const time = new Date(LOG_EPOCH + i * MS_PER_LINE).toISOString();
    const module = `\x1b[38;5;${random(PALETTE_SIZE)}m${"luciole.core".padEnd(MODULE_WIDTH)}\x1b[0m`;
    const words = Array.from({ length: MESSAGE_WORDS }, () => WORDS[random(WORDS.length)]).join(
      " ",
    );
    const rgb = `${random(CHANNEL)};${random(CHANNEL)};${random(CHANNEL)}`;
    out += `\x1b[2m${time}\x1b[0m ${LEVELS[random(LEVELS.length)]} ${module} \x1b[38;2;${rgb}m${words}\x1b[0m\r\n`;
  }
  return Buffer.from(out);
}

const recorders: Record<StreamName, () => Promise<Uint8Array>> = {
  seq: () => record(["seq", "1", String(SEQ_LINES)]),
  "ls-color": () =>
    record(["ls", "-laR", "--color=always", "node_modules/@opentui", "node_modules/@tanstack"]),
  // vim paging through the framework's largest source with syntax highlighting: full
  // alternate-screen redraws, scroll regions and SGR churn, as an editor really emits.
  vim: () =>
    record(
      ["vim", "-u", "NONE", "-N", "-i", "NONE", "+syntax on", "+set number", "src/client.tsx"],
      async (write) => {
        await Bun.sleep(VIM_START_MS);
        for (let i = 0; i < VIM_PAGES; i++) {
          write(i < VIM_PAGES / 2 ? "\x06" : "\x02"); // Ctrl-F, then Ctrl-B
          await Bun.sleep(VIM_STEP_MS);
        }
        write(":q!\r");
      },
    ),
  "ansi-log": async () => ansiLog(),
};

/** The recorded stream, recording it on first use. */
export async function stream(name: StreamName): Promise<Uint8Array> {
  const file = Bun.file(join(OUT, `${name}.bin`));
  if (await file.exists()) return new Uint8Array(await file.arrayBuffer());
  await mkdir(OUT, { recursive: true });
  const bytes = await recorders[name]();
  await Bun.write(file, bytes);
  return bytes;
}

if (import.meta.main)
  for (const name of STREAM_NAMES) console.log(name, (await stream(name)).byteLength, "bytes");
