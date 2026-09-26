/**
 * The web runtime inside an `iframe` of a page on the same origin (docs/WEB.md, "Page
 * embarquée"): the landing page's live demos. The embedding page is told how far the
 * start has gone, may type into the terminal as a keyboard would, and may fix the grid
 * so the live screen matches a capture of it cell for cell. Another origin gets none of
 * it: a page elsewhere must not drive an application it frames.
 */
import * as z from "zod/mini";

/** How far the page has gone, in order; the embedding page shows it while it waits. */
export const STAGES = ["runtime", "bundle", "server", "terminal", "drawn"] as const;
export type Stage = (typeof STAGES)[number];

const Input = z.object({ source: z.literal("airtty"), type: z.literal("input"), data: z.string() });

const MIN_GRID = 10;
const MAX_GRID = 1000;
const Size = z.coerce.number().check(z.int(), z.gte(MIN_GRID), z.lte(MAX_GRID));
const Grid = z.object({ columns: Size, rows: Size });
export type Grid = z.infer<typeof Grid>;

export const embedded = window.parent !== window;

export function stage(name: Stage) {
  if (embedded)
    window.parent.postMessage({ source: "airtty", type: "stage", stage: name }, location.origin);
}

/** Text the embedding page types, as if from the keyboard. */
export function onInput(handler: (data: string) => void) {
  if (!embedded) return;
  addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.source !== window.parent) return;
    const input = Input.safeParse(event.data);
    if (input.success) handler(input.data.data);
  });
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
