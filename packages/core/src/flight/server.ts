// React Flight ships no declarations for these entries: types.d.ts declares them. An import
// cannot carry ambient module declarations, so a reference brings them to consumers too.
// oxlint-disable-next-line typescript/triple-slash-reference -- the ambient Flight declarations above.
/// <reference path="../../types.d.ts" />
import { PassThrough, Readable } from "node:stream";
import { renderToPipeableStream } from "react-server-dom-webpack/server.node";
import { relayBody } from "../cache/render";
import { digestOf, readNotFound } from "../not-found";
export {
  registerClientReference,
  registerServerReference,
  decodeReply,
} from "react-server-dom-webpack/server.node";
/** `failed` hears each error the render raised, apart from a not-found and a cancellation. */
export function renderToReadableStream(
  model: unknown,
  manifest: unknown,
  failed?: (error: unknown) => void,
) {
  const output = new PassThrough();
  // Once the reader left, Flight reports its abort and its failed writes: no failure.
  let left = false;
  const render = renderToPipeableStream(model, manifest, {
    onError: (error: unknown) => {
      if (!left && !readNotFound(error)) failed?.(error);
      return digestOf(error);
    },
  });
  output.on("close", () => {
    left = true;
    render.abort();
  });
  // Register our departure before Flight's own destination-close listener aborts
  // its tasks, so cancellation never becomes a reported render failure.
  render.pipe(output);
  // The native adapter destroys the Node source on cancellation; an iterator's
  // return() queues behind its pending next() and cannot interrupt that read.
  // Narrow the adapter's Node declaration to the host's stream type without
  // assuming that untyped Node chunks already satisfy our byte contract.
  const native: unknown = Readable.toWeb(output, { strategy: { highWaterMark: 1 } });
  if (!(native instanceof ReadableStream)) throw new TypeError("Node did not return a web stream");
  const stream = native.pipeThrough(
    new TransformStream<unknown, Uint8Array>({
      transform(value, controller) {
        if (!(value instanceof Uint8Array))
          throw new TypeError("Flight wrote a chunk that is not bytes");
        controller.enqueue(value);
      },
    }),
  );
  return relayBody(stream, {
    cancel: () => {
      left = true;
    },
  });
}
