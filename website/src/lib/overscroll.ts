// The wheel over a live terminal, as a browser chains it between nested scrollers: the
// application gets it first; when its screen has not changed by the time it should have
// answered, it had nothing to scroll there, and the wheel goes on to the page, the turns
// it already took included. The page keeps it until the screen changes again or the wheel
// turns the other way, when the application gets the next turn back.

/** How long an application takes, once a turn has reached it, to redraw what scrolled. */
const ANSWER_MS = 200;
/** Wheel events further apart than this are two gestures: the page's hold ends. */
const GESTURE_GAP_MS = 600;
const LINE_PX = 16;

export type OverscrollOptions = {
  /** The web runtime's frame, same origin: its wheel events are read before its terminal. */
  frame: HTMLIFrameElement;
  /** How long a turn takes to reach the application (0 when its keys are local). */
  delayMs: () => number;
  signal: AbortSignal;
};

/** Starts chaining the frame's wheel to the page; call the result on each screen write. */
export function overscroll({ frame, delayMs, signal }: OverscrollOptions): () => void {
  const inner = frame.contentWindow;
  if (!inner) return () => {};
  /** Pixels turned since the screen last changed, and when the first of them was. */
  let unanswered = 0;
  let since: number | undefined;
  let page = false;
  let last = 0;
  let direction = 0;
  let check: ReturnType<typeof setTimeout> | undefined;

  const scroll = (top: number) => scrollBy({ top, behavior: "instant" });
  const pixels = (event: WheelEvent) =>
    event.deltaMode === 1
      ? event.deltaY * LINE_PX
      : event.deltaMode === 2
        ? event.deltaY * innerHeight
        : event.deltaY;

  const giveToPage = () => {
    if (page || since === undefined) return;
    if (performance.now() < since + delayMs() + ANSWER_MS) return;
    page = true;
    scroll(unanswered);
    unanswered = 0;
  };

  inner.addEventListener(
    "wheel",
    (event) => {
      const now = performance.now();
      const turn = Math.sign(event.deltaY);
      if (now - last > GESTURE_GAP_MS || (turn && direction && turn !== direction)) page = false;
      last = now;
      if (turn) direction = turn;
      if (page) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return scroll(pixels(event));
      }
      unanswered += pixels(event);
      since ??= now;
      clearTimeout(check);
      check = setTimeout(giveToPage, Math.max(0, since + delayMs() + ANSWER_MS - now));
    },
    { capture: true, passive: false, signal },
  );

  return () => {
    unanswered = 0;
    since = undefined;
    page = false;
    clearTimeout(check);
  };
}
