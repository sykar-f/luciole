/**
 * The page's side of the protocol (protocol.ts): a `fetch` that sends the Application's
 * requests to its in-browser Server. One SharedWorker per application name serves every
 * tab (docs/WEB.md, decision 2); where SharedWorker is missing, a dedicated Worker under a
 * Web Lock, and a second tab is told the application is open elsewhere.
 */
import { PageMessage, ServerMessage, type Port } from "./protocol";

type Pending = {
  head: (response: Response) => void;
  fail: (error: Error) => void;
  stream?: ReadableStreamDefaultController<Uint8Array>;
};

async function exclusive(name: string) {
  const granted = await new Promise<boolean>((resolve) => {
    void navigator.locks.request(`airtty:${name}`, { ifAvailable: true }, (lock) => {
      resolve(lock !== null);
      // Held as long as this page lives.
      return lock ? new Promise<never>(() => {}) : undefined;
    });
  });
  if (!granted) throw new Error(`${name} is already open in another tab of this browser`);
}

export async function connectServer(script: URL, name: string) {
  let port: Port;
  if (typeof SharedWorker === "function") {
    port = new SharedWorker(script, { type: "module", name }).port;
  } else {
    await exclusive(name);
    port = new Worker(script, { type: "module", name });
  }
  const pending = new Map<number, Pending>();
  let sequence = 0;
  port.addEventListener("message", (event) => {
    const message = ServerMessage.safeParse(event.data);
    if (!message.success) return;
    const entry = pending.get(message.data.id);
    if (!entry) return;
    switch (message.data.type) {
      case "head": {
        const body = new ReadableStream<Uint8Array>({
          start: (controller) => void (entry.stream = controller),
          cancel: () => {
            pending.delete(message.data.id);
            send({ type: "cancel", id: message.data.id });
          },
        });
        entry.head(
          new Response(body, { status: message.data.status, headers: message.data.headers }),
        );
        return;
      }
      case "chunk":
        entry.stream?.enqueue(message.data.bytes);
        return;
      case "end":
        entry.stream?.close();
        pending.delete(message.data.id);
        return;
      case "error": {
        const error = new Error(message.data.message);
        if (entry.stream) entry.stream.error(error);
        else entry.fail(error);
        pending.delete(message.data.id);
      }
    }
  });
  port.start?.();
  const send = (message: PageMessage, transfer: Transferable[] = []) =>
    port.postMessage(message, transfer);

  /** The transport's `fetch` (src/transport.ts `Fetch`): URL and init, to the Worker. */
  return async (input: URL, init: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer();
    const id = ++sequence;
    const response = new Promise<Response>((head, fail) => pending.set(id, { head, fail }));
    const signal = init.signal;
    signal?.addEventListener(
      "abort",
      () => {
        const entry = pending.get(id);
        pending.delete(id);
        send({ type: "cancel", id });
        const reason = signal.reason instanceof Error ? signal.reason : new Error("Aborted");
        if (entry?.stream) entry.stream.error(reason);
        else entry?.fail(reason);
      },
      { once: true },
    );
    send(
      {
        type: "request",
        id,
        method: request.method,
        path: `${input.pathname}${input.search}`,
        headers: [...request.headers],
        body,
      },
      body ? [body] : [],
    );
    return response;
  };
}
