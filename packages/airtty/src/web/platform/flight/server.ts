// React Flight ships no declarations for these entries: types.d.ts declares them. An import
// cannot carry ambient module declarations, so a reference brings them to consumers too.
// oxlint-disable-next-line typescript/triple-slash-reference -- the ambient Flight declarations above.
/// <reference path="../../../../types.d.ts" />
/**
 * src/flight/server.ts on web streams, for a Server without `node:stream` (the web target's
 * Worker, docs/WEB.md W5): same exports, same digests. The Bun Server keeps the Node entry,
 * whose request storage rests on `node:async_hooks`; this one uses a global
 * `AsyncLocalStorage` when the host provides one.
 */
import { renderToReadableStream as render } from "react-server-dom-webpack/server.edge";
import { digestOf } from "../../../not-found";
export {
  registerClientReference,
  registerServerReference,
  decodeReply,
} from "react-server-dom-webpack/server.edge";
export function renderToReadableStream(model: unknown, manifest: unknown) {
  return render(model, manifest, { onError: digestOf });
}
