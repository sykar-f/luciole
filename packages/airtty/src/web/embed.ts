/**
 * The web runtime inside an `iframe` of a page on the same origin (docs/WEB.md, "Page
 * embarquée"): the landing page's live demos. The embedding page is told how far the
 * start has gone and what the application sends over the wire, may type into the
 * terminal as a keyboard would, set the network's latency and the next request's fault,
 * and fix the grid so the live screen matches a capture of it cell for cell. Another
 * origin gets none of it: a page elsewhere must not drive an application it frames.
 */
import * as z from "zod/mini";
import type { ApplicationEvent } from "../client";
import type { Fetch, Fault, NetworkConditions } from "../transport";

/** How far the page has gone, in order; the embedding page shows it while it waits. */
export const STAGES = ["runtime", "bundle", "server", "terminal", "drawn"] as const;
export type Stage = (typeof STAGES)[number];

const MAX_LATENCY_MS = 10_000;
const Command = z.discriminatedUnion("type", [
  z.object({ source: z.literal("airtty"), type: z.literal("input"), data: z.string() }),
  z.object({
    source: z.literal("airtty"),
    type: z.literal("network"),
    /** Round trip, half on the way there, half on the way back. */
    latencyMs: z.number().check(z.gte(0), z.lte(MAX_LATENCY_MS)),
    /** For the next request only (src/transport.ts, `Fault`). */
    fault: z.optional(z.enum(["refuse", "drop", "cut"])),
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
  window.parent.postMessage({ source: "airtty", ...message }, location.origin);

export function stage(name: Stage) {
  if (embedded) tell({ type: "stage", stage: name });
}

/** What the transport did, request by request, and what the Server invalidated. */
export function tellEvent(event: ApplicationEvent) {
  if (!embedded) return;
  if (event.type === "loader" || event.type === "chunk") return;
  tell({ type: "event", event });
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
export function controlledNetwork(inner: Fetch): { fetch: Fetch; network: NetworkConditions } {
  let latencyMs = 0;
  let next: Fault | undefined;
  handlers.network = (command) => {
    latencyMs = command.latencyMs;
    next = command.fault;
  };
  return {
    async fetch(input, init) {
      const ms = latencyMs;
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
