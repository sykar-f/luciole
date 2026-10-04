// What an application rewrites in a framed web runtime, told by the frame's own terminal
// (same origin, docs/WEB.md "Page embarquée", `lucioleWrites`): at each of its renders, how
// many cells differ from the last one, character or style.
import * as z from "zod/mini";

export type WritesOptions = {
  /** The web runtime's frame, drawn: its terminal tells its renders through its window. */
  frame: HTMLIFrameElement;
  signal: AbortSignal;
  /** Told how many cells each change wrote. */
  onWritten: (cells: number) => void;
};

/** Tells `onWritten` the cells each render of the frame's application wrote, until `signal` aborts. */
export function writes({ frame, signal, onWritten }: WritesOptions) {
  const inner = frame.contentWindow;
  const subscribe: unknown = inner ? Reflect.get(inner, "lucioleWrites") : undefined;
  if (!inner || typeof subscribe !== "function") return;
  const rendered = (_told: unknown, count: unknown) => {
    if (signal.aborted) return;
    const written = z.number().safeParse(count).data ?? 0;
    if (written) onWritten(written);
  };
  const stop: unknown = Reflect.apply(subscribe, inner, [rendered]);
  signal.addEventListener("abort", () => {
    if (typeof stop === "function") Reflect.apply(stop, inner, []);
  });
}
