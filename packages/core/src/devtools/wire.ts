import { chmod, unlink } from "node:fs/promises";
import type { Socket } from "bun";
import { message, PLUGIN, type Address, type Hello, type Message } from "./protocol";

/**
 * The DevTools transport: newline-delimited JSON over a Unix socket, or one JSON message per
 * WebSocket frame. The DevTools listen; each inspected process (a Client, a Server)
 * connects, says `hello`, then streams its messages and receives commands.
 */

/** BigInts survive as strings (TanStack's bus does the same); nothing else is special. */
export const encode = (value: Message) =>
  JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

/** Splits a byte stream into complete lines, keeping a partial one (and a split UTF-8 character). */
function lineReader(onLine: (line: string) => void) {
  const decoder = new TextDecoder();
  let rest = "";
  return (chunk: Uint8Array | string) => {
    rest += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let newline = rest.indexOf("\n");
    while (newline >= 0) {
      const line = rest.slice(0, newline);
      rest = rest.slice(newline + 1);
      if (line) onLine(line);
      newline = rest.indexOf("\n");
    }
  };
}
const parse = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

/** What an inspected process holds: fire and forget, never throws, never blocks. */
export type Agent = {
  send(message: Message): void;
  readonly connected: boolean;
  close(): void;
};
export type AgentOptions = {
  address: Address;
  hello: Hello;
  /** A message from the DevTools, unchecked: the receiver validates it. */
  onCommand?: (value: unknown) => void;
  /** Messages kept while no DevTools listen, sent on connection (oldest dropped first). */
  backlog?: number;
  retryMs?: number;
};
const DEFAULT_BACKLOG = 2000;
const DEFAULT_RETRY_MS = 1000;
// A DevTools that stops reading must not grow this process's memory without bound.
const MAX_PENDING_BYTES = 8_388_608; // 8 MiB
const OWNER_ONLY = 0o600;
const FORBIDDEN = 403,
  UPGRADE_REQUIRED = 426;
type Link = { write(line: string): void; close(): void };

/**
 * Connects to the DevTools at `address`, and again after they restart. Until a
 * connection exists, the latest `backlog` messages wait, so a DevTools opened after the
 * application still sees its start. Sockets are unref'd: they never keep a process alive.
 */
export function connectAgent(options: AgentOptions): Agent {
  const backlog: Message[] = [];
  const limit = options.backlog ?? DEFAULT_BACKLOG;
  let link: Link | undefined;
  let closed = false;
  let dropped = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const onLine = (line: string) => {
    const value = parse(line);
    if (value !== undefined) options.onCommand?.(value);
  };
  const connected = (next: Link) => {
    link = next;
    next.write(encode(message(PLUGIN.bus, "hello", options.hello)));
    if (dropped) next.write(encode(message(PLUGIN.bus, "dropped", { count: dropped })));
    dropped = 0;
    for (const queued of backlog.splice(0)) next.write(encode(queued));
  };
  const lost = () => {
    link = undefined;
    if (closed || retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      void open();
    }, options.retryMs ?? DEFAULT_RETRY_MS);
    retry.unref();
  };
  async function open() {
    if (closed) return;
    try {
      if (options.address.kind === "unix") await openUnix(options.address.path);
      else openSocket(options.address.url);
    } catch {
      lost();
    }
  }
  async function openUnix(path: string) {
    const pending: Uint8Array[] = [];
    let pendingBytes = 0;
    const encoder = new TextEncoder();
    const read = lineReader(onLine);
    const flush = (socket: Socket) => {
      while (pending.length) {
        const [head] = pending;
        if (!head) break;
        const written = socket.write(head);
        pendingBytes -= Math.max(written, 0);
        if (written < head.byteLength) {
          pending[0] = head.subarray(Math.max(written, 0));
          return;
        }
        pending.shift();
      }
    };
    const socket = await Bun.connect({
      unix: path,
      socket: {
        data: (_socket, chunk) => read(chunk),
        drain: flush,
        close: lost,
        error: lost,
      },
    });
    socket.unref();
    connected({
      write(line) {
        const bytes = encoder.encode(line + "\n");
        if (pendingBytes + bytes.byteLength > MAX_PENDING_BYTES) {
          dropped++;
          return;
        }
        pending.push(bytes);
        pendingBytes += bytes.byteLength;
        if (pending.length === 1) flush(socket);
      },
      close: () => socket.end(),
    });
  }
  function openSocket(url: string) {
    const socket = new WebSocket(url);
    const read = lineReader(onLine);
    socket.onopen = () =>
      connected({
        write(line) {
          if (socket.bufferedAmount > MAX_PENDING_BYTES) dropped++;
          else socket.send(line);
        },
        close: () => socket.close(),
      });
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data === "string") read(event.data + "\n");
    };
    socket.onclose = lost;
  }
  void open();
  return {
    send(next) {
      if (closed) return;
      if (link) {
        link.write(encode(next));
        return;
      }
      backlog.push(next);
      if (backlog.length > limit) {
        backlog.shift();
        dropped++;
      }
    },
    get connected() {
      return link !== undefined;
    },
    close() {
      closed = true;
      clearTimeout(retry);
      link?.close();
      link = undefined;
    },
  };
}

/** One inspected process, as the DevTools see it. */
export type Connection = {
  id: number;
  send(message: Message): void;
  close(): void;
};
export type BusOptions = {
  address: Address;
  onOpen?: (connection: Connection) => void;
  /** A message, parsed but unchecked: the receiver validates it. */
  onMessage: (connection: Connection, value: unknown) => void;
  onClose?: (connection: Connection) => void;
};
export type Bus = { address: Address; close(): void };

/**
 * Listens for inspected processes. A Unix socket path left by a DevTools that died is
 * reused; one a live DevTools listens on is refused, never stolen.
 */
export async function listenBus(options: BusOptions): Promise<Bus> {
  let sequence = 0;
  if (options.address.kind === "unix") {
    const path = options.address.path;
    const alive = await Bun.connect({ unix: path, socket: { data() {} } }).then(
      (socket) => {
        socket.end();
        return true;
      },
      () => false,
    );
    if (alive) throw new Error(`Another DevTools already listens on ${path}`);
    await unlink(path).catch(() => {});
    type State = { connection: Connection; read: (chunk: Uint8Array) => void };
    const listener = Bun.listen<State | undefined>({
      unix: path,
      socket: {
        open(socket) {
          const connection: Connection = {
            id: ++sequence,
            send: (next) => void socket.write(encode(next) + "\n"),
            close: () => socket.end(),
          };
          socket.data = {
            connection,
            read: lineReader((line) => {
              const value = parse(line);
              if (value !== undefined) options.onMessage(connection, value);
            }),
          };
          options.onOpen?.(connection);
        },
        data: (socket, chunk) => socket.data?.read(chunk),
        close(socket) {
          if (socket.data) options.onClose?.(socket.data.connection);
        },
      },
    });
    // Only this user may stream events to, or receive commands from, this DevTools.
    await chmod(path, OWNER_ONLY);
    return {
      address: options.address,
      close() {
        listener.stop(true);
        void unlink(path).catch(() => {});
      },
    };
  }
  const url = new URL(options.address.url);
  type Data = { connection?: Connection };
  const server = Bun.serve<Data>({
    hostname: url.hostname,
    port: Number(url.port),
    fetch(request, bun) {
      // Browsers may not open a socket to a DevTools: a web page could drive the app.
      if (request.headers.has("origin")) return new Response("Forbidden", { status: FORBIDDEN });
      return bun.upgrade(request, { data: {} })
        ? undefined
        : new Response("WebSocket only", { status: UPGRADE_REQUIRED });
    },
    websocket: {
      open(socket) {
        const connection: Connection = {
          id: ++sequence,
          send: (next) => void socket.send(encode(next)),
          close: () => socket.close(),
        };
        socket.data.connection = connection;
        options.onOpen?.(connection);
      },
      message(socket, data) {
        const { connection } = socket.data;
        if (!connection) return;
        for (const line of String(data).split("\n")) {
          const value = line ? parse(line) : undefined;
          if (value !== undefined) options.onMessage(connection, value);
        }
      },
      close(socket) {
        if (socket.data.connection) options.onClose?.(socket.data.connection);
      },
    },
  });
  const address: Address = {
    kind: "ws",
    url: `ws://${url.hostname}:${server.port}${url.pathname === "/" ? "" : url.pathname}`,
  };
  return { address, close: () => void server.stop(true) };
}
