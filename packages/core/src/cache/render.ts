import { renderTags } from "./scope";

/**
 * A byte relay whose pipe owns completion. A sink write holds upstream backpressure
 * until the next pull; cancellation aborts the pipe and releases that write, so the
 * pipe can cancel its source even when a read is pending. No read continuation owns
 * the output controller after the consumer cancels it.
 */
export function relayBody(
  body: ReadableStream<Uint8Array>,
  observe: {
    chunk?: (value: Uint8Array) => void;
    cancel?: (reason: unknown) => void;
    end?: (result: { type: "end"; cancelled: boolean } | { type: "error"; error: unknown }) => void;
  } = {},
): ReadableStream<Uint8Array> {
  const stop = new AbortController();
  let resume = () => {};
  let completion: Promise<void>;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      completion = body
        .pipeTo(
          new WritableStream<Uint8Array>({
            write(value) {
              const consumed = new Promise<void>((resolve) => {
                resume = resolve;
              });
              observe.chunk?.(value);
              controller.enqueue(value);
              return consumed;
            },
            close() {
              controller.close();
            },
          }),
          { signal: stop.signal, preventAbort: true },
        )
        .then(
          () => observe.end?.({ type: "end", cancelled: false }),
          (error: unknown) => {
            if (stop.signal.aborted) {
              observe.end?.({ type: "end", cancelled: true });
            } else {
              observe.end?.({ type: "error", error });
              controller.error(error);
            }
          },
        );
    },
    pull() {
      resume();
    },
    cancel(reason) {
      observe.cancel?.(reason);
      stop.abort(reason);
      resume();
      return completion;
    },
  });
}

/**
 * The root model of a `/render` response: the page, rendered as its own Flight stream,
 * and the "use cache" tags that render read, resolved once its stream ended (content
 * below Suspense included). Flight tells no one when a response is complete, and a
 * promise in the same response would keep it open: the page's own stream does end, so
 * it is the one observed. The shell still leaves as soon as Flight writes it.
 */
export function renderPage(
  // A page element; any Flight model streams the same way (streams, iterables, promises).
  tree: unknown,
  render: (model: unknown) => ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const read = new Set<string>();
  const page = renderTags.run(read, () => render(tree));
  let settle = (_tags: string[]) => {};
  const tags = new Promise<string[]>((resolve) => (settle = resolve));
  // The page's pipe settles once on completion, error or cancellation, with the
  // tags it read so far. Flight owns cancellation of this serialized stream.
  const stream = relayBody(page, { end: () => settle([...read]) });
  return render({ tree: stream, tags });
}
