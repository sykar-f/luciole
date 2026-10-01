// The wheel over a live terminal, as a browser chains it between nested scrollers: the
// application gets it while what is under the pointer can still scroll that way, the page
// once it cannot (lib/wheel.ts decides, gesture by gesture). The runtime says which, from
// the screen it shows (docs/WEB.md, "Page embarquée", `lucioleScrollRoom`): over a slowed
// link, a screen that has not answered yet is not taken for one with nothing to scroll.

import * as z from "zod/mini";
import { wheelChain } from "./wheel";

const LINE_PX = 16;
const Room = z.object({ up: z.boolean(), down: z.boolean() });

export type OverscrollOptions = {
  /** The web runtime's frame, same origin: its wheel events are read before its terminal. */
  frame: HTMLIFrameElement;
  signal: AbortSignal;
};

/** Starts chaining the frame's wheel to the page. */
export function overscroll({ frame, signal }: OverscrollOptions) {
  const inner = frame.contentWindow;
  if (!inner) return;
  const chain = wheelChain();
  /** What the application can still scroll at a point of the frame; unknown: everything. */
  const room = (x: number, y: number) => {
    const read: unknown = Reflect.get(inner, "lucioleScrollRoom");
    if (typeof read !== "function") return undefined;
    return Room.safeParse(Reflect.apply(read, inner, [x, y])).data;
  };
  const pixels = (event: WheelEvent) =>
    event.deltaMode === 1
      ? event.deltaY * LINE_PX
      : event.deltaMode === 2
        ? event.deltaY * innerHeight
        : event.deltaY;

  // The page's own gestures: one that sweeps the terminal under the pointer stays the page's.
  addEventListener("wheel", (event) => chain.outside(performance.now(), event.deltaY), {
    passive: true,
    signal,
  });
  inner.addEventListener(
    "wheel",
    (event) => {
      const owner = chain.turn(performance.now(), event.deltaY, () =>
        room(event.clientX, event.clientY),
      );
      if (owner === "app") return;
      // Kept from the terminal, which would send it to the application and cancel it.
      event.stopImmediatePropagation();
      // A turn the browser no longer lets the page cancel, it scrolls itself.
      if (!event.cancelable) return;
      event.preventDefault();
      scrollBy({ top: pixels(event), behavior: "instant" });
    },
    { capture: true, passive: false, signal },
  );
}
