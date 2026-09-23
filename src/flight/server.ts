// oxlint-disable-next-line typescript/triple-slash-reference -- Include ambient Flight module declarations when consumers import the framework.
/// <reference path="../../types.d.ts" />
import { PassThrough } from "node:stream";
import { renderToPipeableStream } from "react-server-dom-webpack/server.node";
import { digestOf } from "../not-found";
export {
  registerClientReference,
  registerServerReference,
  decodeReply,
} from "react-server-dom-webpack/server.node";
export function renderToReadableStream(model: unknown, manifest: unknown) {
  const output = new PassThrough();
  const render = renderToPipeableStream(model, manifest, {
    onError: digestOf,
  });
  render.pipe(output);
  output.on("close", () => render.abort());
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
      await chunks.return?.();
    },
  });
}
