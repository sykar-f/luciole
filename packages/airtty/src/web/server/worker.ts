/**
 * The in-browser Server's side of the protocol (protocol.ts): every tab that connects
 * sends requests to one handler, the Server's own (src/server.ts `createHandler`). A tab
 * is listened to as soon as it connects; its requests wait until the Server is ready.
 */
import { messageOf } from "../../guards";
import { PageMessage, type Port, type ServerMessage } from "./protocol";

type Handler = (request: Request) => Promise<Response>;
const ORIGIN = "http://airtty.local";
let ready: (handler: Handler) => void = () => {};
const handler = new Promise<Handler>((resolve) => (ready = resolve));

function send(port: Port, message: ServerMessage, transfer: Transferable[] = []) {
  port.postMessage(message, transfer);
}

/** A tab's port: listened to now, served once the Server is ready. */
export function connect(port: Port) {
  const running = new Map<number, AbortController>();
  port.addEventListener("message", (event) => {
    const message = PageMessage.safeParse(event.data);
    if (!message.success) return;
    if (message.data.type === "cancel") {
      running.get(message.data.id)?.abort();
      return;
    }
    const { id, method, path, headers, body } = message.data;
    const cancel = new AbortController();
    running.set(id, cancel);
    void (async () => {
      try {
        const handle = await handler;
        const response = await handle(
          new Request(new URL(path, ORIGIN), { method, headers, body, signal: cancel.signal }),
        );
        send(port, { type: "head", id, status: response.status, headers: [...response.headers] });
        const reader = response.body?.getReader();
        cancel.signal.addEventListener("abort", () => void reader?.cancel(), { once: true });
        for (;;) {
          const chunk = await reader?.read();
          if (!chunk || chunk.done) break;
          send(port, { type: "chunk", id, bytes: chunk.value }, [chunk.value.buffer]);
        }
        send(port, { type: "end", id });
      } catch (error) {
        if (!cancel.signal.aborted) send(port, { type: "error", id, message: messageOf(error) });
      } finally {
        running.delete(id);
      }
    })();
  });
  port.start?.();
}

/** The Server is ready: every tab's requests, those already waiting first, go to it. */
export function serveWith(handle: Handler) {
  ready(handle);
}
