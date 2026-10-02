/**
 * How the wheel scrolls a Markdown document in the web runtime, measured: real wheel
 * events from headless Chrome (`Input.dispatchMouseEvent`) over the live terminal, framed
 * as the landing page frames it. Reports what the terminal sent the application (mouse
 * reports), how far and how often the screen moved, the main thread's time, the page's
 * frame pacing and, with --profile, where the CPU went (xterm.js, OpenTUI, React, the page).
 * The counterpart of scripts/pty/scroll-bench.ts, in a real terminal.
 *
 *   (cd website && bun run demo)                  # the demos it frames
 *   bun scripts/web/scroll-bench.ts               # Notes, its long note, in a frame
 *   bun scripts/web/scroll-bench.ts --app mdreader
 *   (cd website && bun run build) && bun scripts/web/scroll-bench.ts --hero   # the duel itself
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import * as z from "zod/mini";
import { Browser } from "./cdp";
import { parseSourceMap, type SourceMap } from "./sourcemap";

const { values: args } = parseArgs({
  options: {
    app: { type: "string", default: "notes" },
    /** The route the application opens on. */
    path: { type: "string" },
    /** The landing page's duel (website/dist), instead of one frame of the runtime. */
    hero: { type: "boolean", default: false },
    /** In the duel: the afterglow switched off, as a reader may. */
    "no-glow": { type: "boolean", default: false },
    profile: { type: "boolean", default: false },
    /** Only these scenarios, comma-separated. */
    only: { type: "string" },
    columns: { type: "string", default: "84" },
    rows: { type: "string", default: "24" },
  },
});
const WEBSITE = join(import.meta.dirname, "../../website");
const COLUMNS = Number(args.columns);
const ROWS = Number(args.rows);
/** The note's scrollbar and the window's padding right of it, in columns, in Notes. */
const NOTE_BAR = 3;
const PATHS: Record<string, string> = {
  notes: "/notes/3",
  mdreader: "/doc/concepts/client-and-server.md",
};
const path = args.path ?? PATHS[args.app] ?? "/";
const FRAME_WIDTH = 900;
const FRAME_HEIGHT = 560;
const SETTLE_MS = 600;
const START_TIMEOUT_MS = 60_000;
/** Highlighting and fonts, after the first screen. */
const FIRST_SETTLE_MS = 1800;
/** Wheel turns up that bring any document back to its top. */
const HOME_TURNS = 6;
/** A frame of the page later than this one missed its display's beat. */
const LATE_FRAME_MS = 20;
const US_PER_MS = 1000;
/** Performance.getMetrics durations are seconds: as milliseconds to a tenth. */
const TENTHS = 10;
const MS_TENTHS = US_PER_MS * TENTHS;
const ESC = "\x1b";
/** A wheel report (SGR 64 and 65, with any modifiers). */
const WHEEL_REPORT = new RegExp(`${ESC}\\[<(6[45]|7[23]|8[01]|8[89]);`, "g");
const RawSourceMap = z.object({ sources: z.array(z.string()), mappings: z.string() });

/**
 * Wheel gestures as Chrome reports them on macOS. A mouse's notch: one event of about a
 * hundred pixels. A trackpad's swipe: many small events, a frame or so apart, whose
 * inertia decays.
 */
type Gesture = { name: string; events: { deltaY: number; gapMs: number }[] };
/** Inertia: what is left of a swipe's speed after a third of its events. */
const DECAY_THIRDS = 3;
const swipe = ({ start, count, gapMs }: { start: number; count: number; gapMs: number }) =>
  Array.from({ length: count }, (_, i) => ({
    deltaY: Math.max(1, Math.round(start * Math.exp(-i / (count / DECAY_THIRDS)))),
    gapMs,
  }));
const GESTURES: Gesture[] = [
  // No wheel: what the page costs on its own over as long, to tell the scrolling apart.
  { name: "idle", events: [{ deltaY: 0, gapMs: 1000 }] },
  { name: "notch", events: [{ deltaY: 100, gapMs: 0 }] },
  { name: "notches", events: Array.from({ length: 10 }, () => ({ deltaY: 100, gapMs: 60 })) },
  { name: "swipe", events: swipe({ start: 40, count: 60, gapMs: 8 }) },
  { name: "flick", events: swipe({ start: 120, count: 40, gapMs: 8 }) },
];

/** What the framed runtime tells the page: what its terminal sent, and when it was drawn. */
const LISTENER = `if (!window.typed) {
  window.typed = [];
  window.drawn = 0;
  addEventListener("message", (event) => {
    const data = event.data;
    if (data?.source !== "luciole") return;
    if (data.type === "typed") window.typed.push(data.data);
    if (data.type === "stage" && data.stage === "drawn") window.drawn++;
  });
}`;
/** The page around the frame: what the runtime tells it, and its own frame pacing. */
const HOST = (src: string) => `<!doctype html><meta charset="utf-8"><title>bench</title>
<style>body{margin:0;background:#0c0c0c}iframe{border:0;width:${FRAME_WIDTH}px;height:${FRAME_HEIGHT}px}</style>
<iframe src="${src}"></iframe>
<script>${LISTENER}</script>`;

/**
 * Recorded in the top page at each of its frames: the interval since the last one, and
 * each framed screen that changed, with how many rows it moved by (the largest shift that
 * keeps most rows) and how many rows it rewrote.
 */
const SAMPLER = `(() => {
  const frames = [...document.querySelectorAll(window.benchFrames ?? "iframe")];
  const read = (frame) => { try { return frame.contentWindow.lucioleScreen?.() } catch { return undefined } };
  const shift = (before, after) => {
    let best = { by: 0, kept: 0 };
    for (let by = -after.length + 1; by < after.length; by++) {
      let kept = 0;
      // Only rows that changed: the ones that stayed are not what moved.
      for (let row = 0; row < after.length; row++)
        if (by && after[row].trim() && after[row] !== before[row] && before[row + by] === after[row]) kept++;
      if (kept > best.kept || (kept === best.kept && Math.abs(by) < Math.abs(best.by))) best = { by, kept };
    }
    return best.by;
  };
  const state = { intervals: [], moves: frames.map(() => []), last: performance.now(), on: true };
  const screens = frames.map(read);
  const tick = (now) => {
    if (!state.on) return;
    state.intervals.push(now - state.last);
    state.last = now;
    frames.forEach((frame, index) => {
      const screen = read(frame);
      const before = screens[index];
      if (screen && before && screen.join("\\n") !== before.join("\\n")) {
        const rewritten = screen.filter((row, i) => row !== before[i]).length;
        state.moves[index].push({ at: now, by: shift(before.map(crop), screen.map(crop)), rewritten });
      }
      screens[index] = screen;
    });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.sampler = state;
})()`;

const Metrics = z.object({ metrics: z.array(z.object({ name: z.string(), value: z.number() })) });
const metrics = async (browser: Browser) =>
  Object.fromEntries(
    Metrics.parse(await browser.send("Performance.getMetrics")).metrics.map((m) => [
      m.name,
      m.value,
    ]),
  );
const Move = z.object({ at: z.number(), by: z.number(), rewritten: z.number() });
const Sampled = z.object({ intervals: z.array(z.number()), moves: z.array(z.array(Move)) });

const ProfileNode = z.object({
  id: z.number(),
  callFrame: z.object({
    functionName: z.string(),
    url: z.string(),
    lineNumber: z.number(),
    columnNumber: z.number(),
  }),
  hitCount: z.optional(z.number()),
});
const Profile = z.object({
  profile: z.object({
    nodes: z.array(ProfileNode),
    startTime: z.number(),
    endTime: z.number(),
    samples: z.optional(z.array(z.number())),
    timeDeltas: z.optional(z.array(z.number())),
  }),
});

/** Who a source of the runtime belongs to. */
function owner(source: string | undefined, url: string, functionName: string) {
  if (functionName === "(garbage collector)") return "gc";
  if (functionName === "(program)") return "browser (layout, paint, style)";
  if (functionName === "(idle)") return "idle";
  if (url.startsWith("wasm://")) return "opentui (wasm)";
  if (url.includes("/app/index.cjs")) return "application bundle";
  if (url.includes("/_astro/") || url.endsWith(".html") || url.includes("/bench")) return "page";
  if (!source) return url ? "runtime (unmapped)" : "native";
  if (source.includes("@xterm")) return "xterm.js";
  if (source.includes("@opentui/react")) return "opentui react";
  if (source.includes("@opentui")) return "opentui (js)";
  if (/react-reconciler|\/react\/|react-dom|scheduler/.test(source)) return "react";
  if (source.includes("packages/core/src")) return "luciole";
  if (source.includes("node_modules"))
    return source.split("node_modules/").pop()?.split("/")[0] ?? "deps";
  return "runtime (other)";
}

function attribute(profile: z.infer<typeof Profile>["profile"], map: SourceMap | undefined) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const totals = new Map<string, number>();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  samples.forEach((id, index) => {
    const node = byId.get(id);
    if (!node) return;
    const { url, lineNumber, columnNumber, functionName } = node.callFrame;
    const source = url.includes("/runtime/runtime.js")
      ? map?.sourceAt(lineNumber, columnNumber)
      : undefined;
    const who = owner(source, url, functionName);
    totals.set(who, (totals.get(who) ?? 0) + (deltas[index + 1] ?? deltas[index] ?? 0) / US_PER_MS);
  });
  return Object.fromEntries(
    [...totals].sort((a, b) => b[1] - a[1]).map(([who, ms]) => [who, Math.round(ms)]),
  );
}

/** The runtime's own source map, from the cache it was built in (src/web-runtime.ts). */
function runtimeMap(runtime: string): SourceMap | undefined {
  const cache = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "luciole/web");
  const built = readFileSync(runtime);
  for (const entry of new Bun.Glob("*/runtime.js").scanSync(cache)) {
    const candidate = join(cache, entry);
    if (!existsSync(`${candidate}.map`) || !readFileSync(candidate).equals(built)) continue;
    return parseSourceMap(RawSourceMap.parse(JSON.parse(readFileSync(`${candidate}.map`, "utf8"))));
  }
  return undefined;
}

const root = join(WEBSITE, args.hero ? "dist" : "public");
if (!existsSync(join(root, "demo", args.app, "index.html")))
  throw new Error(
    `${root}/demo/${args.app} is missing: run "bun run demo" (and "bun run build" for --hero) in website/`,
  );
const map = args.profile ? runtimeMap(join(root, "demo/runtime/runtime.js")) : undefined;
const look = new URLSearchParams({
  columns: String(COLUMNS),
  rows: String(ROWS),
  restore: "off",
  path,
});
const host = HOST(`/demo/${args.app}/index.html?${look}`);
const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  cjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  wasm: "application/wasm",
  svg: "image/svg+xml",
  woff2: "font/woff2",
  scm: "text/plain; charset=utf-8",
};
const site = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url).pathname;
    if (url === "/bench") return new Response(host, { headers: { "content-type": TYPES.html } });
    const served = url.endsWith("/") ? `${url}index.html` : url;
    const file = Bun.file(join(root, served));
    if (url.includes("..") || !(await file.exists()))
      return new Response("Not found", { status: 404 });
    // The duel on another note than its own: a longer one leaves the wheel more to do.
    if (args.hero && args.path && served === "/index.html")
      return new Response(
        (await file.text()).replaceAll(
          "path=%2Fnotes%2F1",
          `path=${encodeURIComponent(args.path)}`,
        ),
        { headers: { "content-type": TYPES.html } },
      );
    const type = TYPES[served.slice(served.lastIndexOf(".") + 1)] ?? "application/octet-stream";
    return new Response(file, { headers: { "content-type": type } });
  },
});

/** The frame wheeled over: the only one, or the duel's luciole screen. */
const FRAME = args.hero
  ? `document.querySelector('iframe[data-side="luciole"]')`
  : `document.querySelector("iframe")`;
const report: Record<string, unknown> = {
  app: args.app,
  path: args.hero ? (args.path ?? "/notes/1") : path,
  hero: args.hero,
  glow: args.hero && !args["no-glow"],
};
try {
  await using browser = await Browser.start();
  await browser.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    // 1: the gestures' deltas are CSS pixels, as a page receives them (CDP scales them).
    deviceScaleFactor: 1,
    mobile: false,
  });
  await browser.send("Performance.enable");
  await browser.open(args.hero ? site.url.href : new URL("/bench", site.url).href);
  if (args.hero)
    await browser.waitFor(
      `[...document.querySelectorAll("[data-frame]")].length === 2 && [...document.querySelectorAll("[data-frame]")].every((f) => f.classList.contains("on"))`,
      "both screens of the duel, live",
      START_TIMEOUT_MS,
    );
  else await browser.waitFor("window.drawn > 0", "the framed runtime, drawn", START_TIMEOUT_MS);
  if (args.hero && args["no-glow"])
    await browser.evaluate(
      `(() => { const glow = document.querySelector("[data-afterglow]"); if (glow?.checked) glow.click(); })()`,
    );
  // The document shown: its first screen, then a moment for highlighting and fonts.
  await browser.waitFor(
    `${FRAME}.contentWindow.lucioleScreen?.().join("").trim().length > 0`,
    "a screen",
  );
  await Bun.sleep(FIRST_SETTLE_MS);
  const screen = z
    .array(z.string())
    .parse(await browser.evaluate(`${FRAME}.contentWindow.lucioleScreen()`));
  console.log(screen.join("\n"));
  // The text being scrolled: right of the list's border, when there is a list, and left
  // of the note's scrollbar, whose thumb moves with the page but is not the text.
  const border = Math.max(...screen.map((row) => row.lastIndexOf("│", COLUMNS / 2)));
  const from = args.app === "notes" && border > 0 && border < COLUMNS / 2 ? border + 2 : 0;
  const to = args.app === "notes" ? COLUMNS - NOTE_BAR : COLUMNS;
  await browser.evaluate(
    `window.crop = (row) => row.slice(${from}, ${to}).trimEnd(); window.benchFrames = ${JSON.stringify(args.hero ? "iframe[data-side]" : "iframe")}`,
  );
  const point = z
    .object({ x: z.number(), y: z.number() })
    .parse(
      await browser.evaluate(
        `(() => { const r = ${FRAME}.getBoundingClientRect(); return { x: r.x + r.width * ${(from + COLUMNS) / 2 / COLUMNS}, y: r.y + r.height / 2 }; })()`,
      ),
    );
  // Every gesture starts from the top of the document.
  const home = async () => {
    for (let i = 0; i < HOME_TURNS; i++)
      await browser.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        ...point,
        deltaX: 0,
        deltaY: -3000,
      });
    await Bun.sleep(SETTLE_MS);
  };
  await browser.evaluate(LISTENER);
  const results: Record<string, unknown> = {};
  const only = args.only?.split(",");
  for (const gesture of GESTURES) {
    if (only && !only.includes(gesture.name)) continue;
    await home();
    await browser.evaluate("window.typed.length = 0");
    await browser.evaluate(SAMPLER);
    const before = await metrics(browser);
    if (args.profile) {
      await browser.send("Profiler.enable");
      await browser.send("Profiler.setSamplingInterval", { interval: 100 });
      await browser.send("Profiler.start");
    }
    const started = performance.now();
    for (const { deltaY, gapMs } of gesture.events) {
      if (deltaY)
        await browser.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          ...point,
          deltaX: 0,
          deltaY,
        });
      if (gapMs) await Bun.sleep(gapMs);
    }
    const sent = performance.now() - started;
    await Bun.sleep(SETTLE_MS);
    const profile = args.profile ? Profile.parse(await browser.send("Profiler.stop")) : undefined;
    const after = await metrics(browser);
    const sampled = Sampled.parse(
      await browser.evaluate("(window.sampler.on = false, window.sampler)"),
    );
    const typed = z.array(z.string()).parse(await browser.evaluate("window.typed"));
    // Wheel reports (SGR 64 and 65, modifiers aside), however many each message carries.
    const reports = typed.reduce((sum, data) => sum + (data.match(WHEEL_REPORT)?.length ?? 0), 0);
    // The duel lists the SSH screen first: the luciole one is wheeled over.
    const moves = sampled.moves[args.hero ? 1 : 0] ?? [];
    const delta = (name: string) =>
      Math.round((after[name] ?? 0) * MS_TENTHS - (before[name] ?? 0) * MS_TENTHS) / TENTHS;
    const steps = moves.map((m) => Math.abs(m.by));
    const gaps = moves.slice(1).map((m, i) => m.at - (moves[i]?.at ?? m.at));
    const sorted = [...sampled.intervals].sort((a, b) => a - b);
    results[gesture.name] = {
      wheelEvents: gesture.events.filter((e) => e.deltaY).length,
      pixels: gesture.events.reduce((sum, e) => sum + e.deltaY, 0),
      sentOverMs: Math.round(sent),
      mouseReports: reports,
      screenUpdates: moves.length,
      linesMoved: steps.reduce((sum, s) => sum + s, 0),
      largestStep: Math.max(0, ...steps),
      rowsRewrittenPerUpdate: moves.length
        ? Math.round(moves.reduce((sum, m) => sum + m.rewritten, 0) / moves.length)
        : 0,
      longestGapBetweenUpdatesMs: Math.round(Math.max(0, ...gaps)),
      mainThreadMs: {
        task: delta("TaskDuration"),
        script: delta("ScriptDuration"),
        layout: delta("LayoutDuration"),
        style: delta("RecalcStyleDuration"),
      },
      pageFrames: {
        count: sampled.intervals.length,
        p50Ms: Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0),
        maxMs: Math.round(sorted.at(-1) ?? 0),
        over20Ms: sampled.intervals.filter((ms) => ms > LATE_FRAME_MS).length,
      },
      ...(profile ? { cpuMs: attribute(profile.profile, map) } : {}),
    };
  }
  report.gestures = results;
} finally {
  await site.stop(true);
}
console.log(JSON.stringify(report, null, 2));
