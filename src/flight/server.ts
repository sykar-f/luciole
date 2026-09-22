import { PassThrough, Readable } from "node:stream";
import { renderToPipeableStream } from "react-server-dom-webpack/server.node";
export {
  registerClientReference,
  registerServerReference,
  decodeReply,
} from "react-server-dom-webpack/server.node";
export function renderToReadableStream(model: unknown, manifest: unknown) {
  const output = new PassThrough();
  const render = renderToPipeableStream(model, manifest, {
    onError: () => "Server render failed",
  });
  render.pipe(output);
  output.on("close", () => render.abort());
  return Readable.toWeb(output) as unknown as ReadableStream<Uint8Array>;
}
