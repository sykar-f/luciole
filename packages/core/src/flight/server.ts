// React Flight ships no declarations for these entries: types.d.ts declares them. An import
// cannot carry ambient module declarations, so a reference brings them to consumers too.
// oxlint-disable-next-line typescript/triple-slash-reference -- the ambient Flight declarations above.
/// <reference path="../../types.d.ts" />
import { PassThrough } from "node:stream";
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
  // A guarded push adapter: cancel detaches data before destroying the destination.
  // Native toWeb can still enqueue Flight's abort writes into a closed controller.
  let terminal = false;
  let detach = () => {};
  const finish = () => {
    terminal = true;
    output.pause();
    detach();
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const data = (value: unknown) => {
          if (terminal) return;
          if (!(value instanceof Uint8Array)) {
            finish();
            controller.error(new TypeError("Flight wrote a chunk that is not bytes"));
            output.destroy();
            return;
          }
          // Arm pressure before enqueue, which may immediately satisfy a pending pull.
          output.pause();
          controller.enqueue(value);
          if ((controller.desiredSize ?? 0) > 0) output.resume();
        };
        detach = () => output.removeListener("data", data);
        output.on("data", data);
        output.on("end", () => {
          if (terminal) return;
          finish();
          controller.close();
        });
        // Keep the error listener after cancellation to observe late destination errors.
        output.on("error", (error: unknown) => {
          if (terminal) return;
          finish();
          controller.error(error);
        });
        output.on("close", () => {
          if (terminal) return;
          finish();
          controller.error(new Error("Flight output closed before ending"));
        });
      },
      pull() {
        if (!terminal) output.resume();
      },
      cancel() {
        finish();
        output.destroy();
      },
    },
    { highWaterMark: 1 },
  );
  return relayBody(stream, {
    cancel: () => {
      left = true;
    },
  });
}
