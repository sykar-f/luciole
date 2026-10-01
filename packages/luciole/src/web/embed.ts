/**
 * The web runtime inside an `iframe` of a page on the same origin (docs/WEB.md, "Page
 * embarquée"): the landing page's live demos. The embedding page is told how far the
 * start has gone and what the application sends over the wire, may type into the
 * terminal as a keyboard would, set the network's latency, where it sits (before the
 * requests or before the keys) and the next request's fault,
 * and fix the grid so the live screen matches a capture of it cell for cell. Another
 * origin gets none of it: a page elsewhere must not drive an application it frames.
 */
import * as z from "zod/mini";
import type { ApplicationEvent } from "../client";
import type { Fetch, Fault, NetworkConditions } from "../transport";
import { isReply } from "./replies";

/** How far the page has gone, in order; the embedding page shows it while it waits. */
export const STAGES = ["runtime", "bundle", "server", "terminal", "drawn"] as const;
export type Stage = (typeof STAGES)[number];

const MAX_LATENCY_MS = 10_000;
const Command = z.discriminatedUnion("type", [
  z.object({ source: z.literal("luciole"), type: z.literal("input"), data: z.string() }),
  z.object({
    source: z.literal("luciole"),
    type: z.literal("network"),
    /** Round trip, half on the way there, half on the way back. */
    latencyMs: z.number().check(z.gte(0), z.lte(MAX_LATENCY_MS)),
    /** For the next request only (src/transport.ts, `Fault`). */
    fault: z.optional(z.enum(["refuse", "drop", "cut"])),
    /**
     * Where the round trip sits. `requests` (the default): between the application and its
     * Server, as luciole splits it. `keys`: between the keyboard and the application, as
     * over SSH, where the whole application runs next to its data: each key waits the
     * round trip, and requests none.
     */
    delays: z.optional(z.enum(["requests", "keys"])),
  }),
]);
type Command = z.infer<typeof Command>;

const MIN_GRID = 10;
const MAX_GRID = 1000;
const Size = z.coerce.number().check(z.int(), z.gte(MIN_GRID), z.lte(MAX_GRID));
const Grid = z.object({ columns: Size, rows: Size });
export type Grid = z.infer<typeof Grid>;

export const embedded = window.parent !== window;

const tell = (message: Record<string, unknown>) =>
  window.parent.postMessage({ source: "luciole", ...message }, location.origin);

export function stage(name: Stage) {
  if (embedded) tell({ type: "stage", stage: name });
}

/** What the transport did, request by request, and what the Server invalidated. */
export function tellEvent(event: ApplicationEvent) {
  if (!embedded) return;
  if (event.type === "loader" || event.type === "chunk") return;
  tell({ type: "event", event });
}

/**
 * What the terminal sends the application, as the emulator encodes it: keys, pastes, and
 * the mouse's clicks and wheel once the application tracks it. The embedding page may
 * replay it in another frame with `input`: two frames of the same grid then follow the
 * same hands.
 */
export function tellTyped(data: string) {
  if (embedded && !isReply(data)) tell({ type: "typed", data });
}

/**
 * The screen as text, for the embedding page to read synchronously: it shares this
 * document's origin, and `lucioleScreen()` on the frame's window answers even while the frame is
 * out of view and the emulator has stopped drawing.
 */
export function exposeScreen(read: () => string[]) {
  Reflect.set(window, "lucioleScreen", read);
}

/**
 * Whether the wheel, at a point of the frame (a `WheelEvent`'s `clientX`/`clientY`), still
 * scrolls something in the application, up and down: `lucioleScrollRoom(x, y)` on the
 * frame's window. Read synchronously, at each turn, from what the screen shows (over a
 * slowed link, the turns still on their way have not moved it yet): the embedding page
 * scrolls itself only where the application has nothing left to scroll, as a browser
 * chains the wheel between nested scrollers.
 */
export function exposeScrollRoom(read: (x: number, y: number) => { up: boolean; down: boolean }) {
  Reflect.set(window, "lucioleScrollRoom", read);
}

const handlers: { [T in Command["type"]]?: (command: Extract<Command, { type: T }>) => void } = {};
if (embedded)
  addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.source !== window.parent) return;
    const command = Command.safeParse(event.data);
    if (!command.success) return;
    if (command.data.type === "input") handlers.input?.(command.data);
    else handlers.network?.(command.data);
  });

/** Text the embedding page types, as if from the keyboard. */
export function onInput(handler: (data: string) => void) {
  handlers.input = (command) => handler(command.data);
}

const halfway = (ms: number, signal: AbortSignal | null | undefined) =>
  new Promise<void>((resolve, reject) => {
    if (!ms) return resolve();
    const timer = setTimeout(resolve, ms / 2);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });

/**
 * The network as the embedding page sets it: a `fetch` that waits half the round trip
 * each way, so the transport measures it as it would a distant Server, and faults the
 * transport applies to the next request. Untouched until the page says otherwise.
 */
export function controlledNetwork(inner: Fetch): {
  fetch: Fetch;
  network: NetworkConditions;
  keys: (deliver: (data: string) => void) => (data: string) => void;
} {
  let latencyMs = 0;
  let delays: "requests" | "keys" = "requests";
  let next: Fault | undefined;
  handlers.network = (command) => {
    latencyMs = command.latencyMs;
    delays = command.delays ?? "requests";
    next = command.fault;
  };
  // Keys arrive in the order they were typed, even when the round trip shrinks meanwhile.
  let lastDelivery = 0;
  return {
    keys: (deliver) => (data) => {
      if (delays !== "keys" || !latencyMs) return deliver(data);
      const at = Math.max(performance.now() + latencyMs, lastDelivery);
      lastDelivery = at;
      setTimeout(() => deliver(data), at - performance.now());
    },
    async fetch(input, init) {
      const ms = delays === "requests" ? latencyMs : 0;
      await halfway(ms, init.signal);
      const response = await inner(input, init);
      await halfway(ms, init.signal);
      return response;
    },
    network: {
      fault() {
        const fault = next;
        next = undefined;
        return fault;
      },
    },
  };
}

const Colour = z.string().check(z.regex(/^[0-9a-f]{6}$/i));
export type Look = { grid?: Grid; background?: string; foreground?: string };

/**
 * `&restore=off`: the page starts where the application starts, not where the reader left
 * it, and remembers nothing for next time: the landing page's demos open on the screen
 * their capture shows, every visit.
 */
export const restoreOf = (search: string) => new URLSearchParams(search).get("restore") !== "off";

/**
 * `?columns=140&rows=40`: a fixed grid, the font sized to fit it. `&background=0a0f16`,
 * `&foreground=e6edf3`: the terminal's default colours, those of the embedding page's own
 * drawing of the screen, so one replaces the other without a flash.
 */
export function lookOf(search: string): Look {
  const params = new URLSearchParams(search);
  const grid = Grid.safeParse({ columns: params.get("columns"), rows: params.get("rows") });
  const colour = (name: string) => {
    const parsed = Colour.safeParse(params.get(name));
    return parsed.success ? `#${parsed.data}` : undefined;
  };
  return {
    grid: grid.success ? grid.data : undefined,
    background: colour("background"),
    foreground: colour("foreground"),
  };
}
