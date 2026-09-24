/** @jsxImportSource @opentui/react */
// Performance of each emulator on the recorded streams (streams.ts):
// - parse throughput: the stream fed in 4 KiB chunks (a PTY read), fresh instance per run;
// - frame cost: reading every visible cell (extract) and drawing it into an OpenTUI
//   buffer (draw), at 80x24 and 200x60, versus OpenTUI's native composition;
// - the React alternative: the grid as <text>/<span> lines, re-rendered per frame;
// - memory: RSS and JS heap per instance, 10 instances holding 1000 lines of scrollback.
// Each emulator runs in its own `bun bench.tsx --one <name>` process: RSS is per process.
// Run: `bun bench.tsx` (records streams on first use, merges into results.json).
import { join } from "node:path";
import { act, createRef, useImperativeHandle, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import { OptimizedBuffer } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { z } from "zod";
import { EMULATORS, EMULATOR_NAMES, xterm, type EmulatorName } from "./emulators";
import { STREAM_COLS, STREAM_NAMES, STREAM_ROWS, stream } from "./streams";
import { fidelity } from "./fidelity";
import { saveSection } from "./results";

const CHUNK = 4096;
const RUNS = 3;
const WARMUP = 20;
const FRAMES = 300;
const MEMORY_INSTANCES = 10;
// A classic terminal and a large one (a maximized window on a laptop screen).
const CLASSIC_COLS = 80;
const CLASSIC_ROWS = 24;
const LARGE_COLS = 200;
const LARGE_ROWS = 60;
const CLASSIC = [CLASSIC_COLS, CLASSIC_ROWS] as const;
const LARGE = [LARGE_COLS, LARGE_ROWS] as const;
const SIZES = [CLASSIC, LARGE];
const HEX = 16;
const MB = 1e6;
const MS_PER_S = 1000;
const US_PER_MS = 1000;
const KB = 1024;
const DECIMALS = 10;

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};
const round = (n: number) => Math.round(n * DECIMALS) / DECIMALS;

async function feedAll(write: (bytes: Uint8Array) => void, bytes: Uint8Array) {
  for (let i = 0; i < bytes.byteLength; i += CHUNK) write(bytes.subarray(i, i + CHUNK));
}

async function throughput(name: EmulatorName) {
  const out: Record<string, number> = {};
  for (const streamName of STREAM_NAMES) {
    const bytes = await stream(streamName);
    const runs: number[] = [];
    for (let run = 0; run < RUNS; run++) {
      const term = await EMULATORS[name](STREAM_COLS, STREAM_ROWS);
      const start = performance.now();
      await feedAll((b) => term.write(b), bytes);
      await term.settle();
      runs.push(performance.now() - start);
      term.dispose();
    }
    out[`${streamName} MB/s`] = round(bytes.byteLength / MB / (median(runs) / MS_PER_S));
  }
  return out;
}

async function frames(name: EmulatorName) {
  const log = await stream("ansi-log");
  const out: Record<string, number> = {};
  for (const [cols, rows] of SIZES) {
    const term = await EMULATORS[name](cols, rows);
    await feedAll((b) => term.write(b), log);
    await term.settle();
    const time = (run: () => void) => {
      for (let i = 0; i < WARMUP; i++) run();
      const samples: number[] = [];
      for (let i = 0; i < FRAMES; i++) {
        const start = performance.now();
        run();
        samples.push(performance.now() - start);
      }
      return round(median(samples) * US_PER_MS);
    };
    out[`extract ${cols}x${rows} µs`] = time(() => term.extract());
    if (term.draw) {
      const buffer = OptimizedBuffer.create(cols, rows, "unicode");
      out[`draw ${cols}x${rows} µs`] = time(() => term.draw?.(buffer));
      buffer.destroy();
    }
    term.dispose();
  }
  return out;
}

async function memory(name: EmulatorName) {
  const ls = await stream("ls-color");
  Bun.gc(true);
  const before = { rss: process.memoryUsage().rss, heap: process.memoryUsage().heapUsed };
  const terms = [];
  for (let i = 0; i < MEMORY_INSTANCES; i++) {
    const term = await EMULATORS[name](STREAM_COLS, STREAM_ROWS);
    await feedAll((b) => term.write(b), ls);
    await term.settle();
    terms.push(term);
  }
  Bun.gc(true);
  const after = { rss: process.memoryUsage().rss, heap: process.memoryUsage().heapUsed };
  for (const term of terms) term.dispose();
  const out: Record<string, number> = {
    "RSS per instance KiB": Math.round((after.rss - before.rss) / MEMORY_INSTANCES / KB),
    "JS heap per instance KiB": Math.round((after.heap - before.heap) / MEMORY_INSTANCES / KB),
  };
  if (name !== "opentui-embedded") return out;
  // Its adapter owns a whole (test) renderer per instance; an app embeds terminals in
  // the one renderer it already has. That renderer's share is measured apart.
  Bun.gc(true);
  const bare = process.memoryUsage().rss;
  const renderers = [];
  for (let i = 0; i < MEMORY_INSTANCES; i++)
    renderers.push(await createTestRenderer({ width: STREAM_COLS, height: STREAM_ROWS }));
  Bun.gc(true);
  out["of which test renderer KiB"] = Math.round(
    (process.memoryUsage().rss - bare) / MEMORY_INSTANCES / KB,
  );
  for (const setup of renderers) setup.renderer.destroy();
  return out;
}

// The grid as React text: one <text> per row, one <span> per run of equal colors. Every
// frame rebuilds the runs and lets the reconciler diff them.
async function reactSpans() {
  const out: Record<string, number> = {};
  const log = await stream("ansi-log");
  for (const [cols, rows] of SIZES) {
    const term = await xterm(cols, rows);
    await feedAll((b) => term.write(b), log);
    await term.settle();
    const grid = await term.grid();
    type Run = { text: string; fg: string };
    const runsOf = (shift: number): Run[][] =>
      Array.from({ length: rows }, (_, y) => {
        const runs: Run[] = [];
        for (let x = 0; x < cols; x++) {
          const cell = grid.cell(x, (y + shift) % rows);
          if (!cell || cell.width === 0) continue;
          const fg = cell.fg
            ? `#${cell.fg.map((c) => c.toString(HEX).padStart(2, "0")).join("")}`
            : "#ffffff";
          const last = runs.at(-1);
          if (last && last.fg === fg) last.text += cell.text || " ";
          else runs.push({ text: cell.text || " ", fg });
        }
        return runs;
      });
    // The benchmark drives re-renders from outside React, through an imperative handle.
    const drive = createRef<(shift: number) => void>();
    function Grid() {
      const [shift, set] = useState(0);
      useImperativeHandle(drive, () => set, []);
      return (
        <box flexDirection="column">
          {runsOf(shift).map((runs, y) => (
            <text key={y} height={1} wrapMode="none">
              {runs.map((run, i) => (
                <span key={i} fg={run.fg}>
                  {run.text}
                </span>
              ))}
            </text>
          ))}
        </box>
      );
    }
    const ui = await testRender(<Grid />, { width: cols, height: rows });
    const samples: number[] = [];
    for (let i = 0; i < WARMUP + FRAMES / DECIMALS; i++) {
      const start = performance.now();
      await act(async () => {
        drive.current?.(i + 1);
      });
      await ui.renderOnce();
      if (i >= WARMUP) samples.push(performance.now() - start);
    }
    out[`react spans ${cols}x${rows} µs`] = round(median(samples) * US_PER_MS);
    await act(async () => ui.renderer.destroy());
    term.dispose();
  }
  return out;
}

async function one(name: EmulatorName) {
  return { ...(await throughput(name)), ...(await frames(name)), ...(await memory(name)) };
}

const PACKAGES: Record<EmulatorName, readonly string[]> = {
  "opentui-embedded": [],
  "libghostty-vt": ["libghostty-vt"],
  "ghostty-web": ["ghostty-web"],
  "xterm-headless": ["@xterm/headless", "@xterm/addon-unicode-graphemes"],
  "ghostty-opentui": [
    "ghostty-opentui",
    "@resvg",
    "strip-ansi",
    "ansi-regex",
    "wcwidth",
    "defaults",
    "clone",
  ],
};
async function installedKiB(packages: readonly string[]) {
  let total = 0;
  for (const p of packages) {
    const du = Bun.spawnSync(["du", "-sk", join(import.meta.dir, "node_modules", p)]);
    total += Number.parseInt(du.stdout.toString(), 10) || 0;
  }
  return total;
}

const Row = z.record(z.string(), z.number());
const flag = process.argv.indexOf("--one");
if (flag >= 0) {
  const name = EMULATOR_NAMES.find((n) => n === process.argv[flag + 1]);
  if (!name) throw new Error(`unknown emulator ${process.argv[flag + 1]}`);
  console.log(JSON.stringify(await one(name)));
  process.exit(0);
}
for (const name of STREAM_NAMES) await stream(name);
const perEmulator: Record<string, Record<string, number>> = {};
for (const name of EMULATOR_NAMES) {
  const child = Bun.spawnSync([process.execPath, import.meta.path, "--one", name], {
    stderr: "inherit",
  });
  if (!child.success) throw new Error(`bench of ${name} failed`);
  const last = child.stdout.toString().trim().split("\n").at(-1) ?? "";
  perEmulator[name] = {
    ...Row.parse(JSON.parse(last)),
    "installed KiB": await installedKiB(PACKAGES[name]),
  };
  console.log(name, perEmulator[name]);
}
const react = await reactSpans();
console.log("react", react);
const streams: Record<string, number> = {};
for (const name of STREAM_NAMES) streams[`${name} bytes`] = (await stream(name)).byteLength;
await saveSection("bench", { streams, emulators: perEmulator, reactSpansXterm: react });
await saveSection("fidelity", { results: await fidelity() });
process.exit(0);
