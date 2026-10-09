// React Flight ships no declarations for these entries: types.d.ts declares them. An import
// cannot carry ambient module declarations, so a reference brings them to consumers too.
// oxlint-disable-next-line typescript/triple-slash-reference -- the ambient Flight declarations above.
/// <reference path="../../types.d.ts" />
import { PassThrough } from "node:stream";
import { renderToPipeableStream } from "react-server-dom-webpack/server.node";
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
  render.pipe(output);
  output.on("close", () => {
    left = true;
    render.abort();
  });
  // Pulled one chunk at a time like Readable.toWeb, whose `node:stream/web` type is not
  // the global ReadableStream. Node streams are untyped: every chunk is checked to be bytes.
  const chunks: AsyncIterator<unknown> = output[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done) controller.close();
      else if (next.value instanceof Uint8Array) controller.enqueue(next.value);
      else controller.error(new TypeError("Flight wrote a chunk that is not bytes"));
    },
    async cancel() {
      // Before the output closes: Flight's next write fails first.
      left = true;
      await chunks.return?.();
    },
  });
}
