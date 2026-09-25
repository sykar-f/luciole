// Decoded Flight values are `unknown`: their type is what the Server sent, checked where
// a type is assumed (see src/guards.ts and the transport's envelope schema).
declare module "react-server-dom-webpack/client.browser" {
  export function createFromReadableStream(
    stream: ReadableStream,
    options: {
      callServer: (id: string, args: unknown[]) => Promise<unknown>;
      replayConsoleLogs?: boolean;
    },
  ): Promise<unknown>;
  export function encodeReply(value: unknown): Promise<string | FormData>;
  export function createServerReference(
    id: string,
    callServer: (id: string, args: unknown[]) => Promise<unknown>,
  ): (...args: unknown[]) => Promise<unknown>;
}
declare module "react-server-dom-webpack/server.node" {
  export function registerClientReference<T>(value: T, id: string, name: string): T;
  export function registerServerReference<T>(value: T, id: string, name: string): T;
  export function renderToPipeableStream(
    model: unknown,
    manifest: unknown,
    options?: { onError?: (error: unknown) => string | undefined },
  ): { pipe(stream: NodeJS.WritableStream): void; abort(): void };
  export function decodeReply(body: string | FormData, manifest: unknown): Promise<unknown>;
}
// The web target's Server (src/web/platform/flight/server.ts): the same codec on web streams.
declare module "react-server-dom-webpack/server.edge" {
  export function registerClientReference<T>(value: T, id: string, name: string): T;
  export function registerServerReference<T>(value: T, id: string, name: string): T;
  export function renderToReadableStream(
    model: unknown,
    manifest: unknown,
    options?: { onError?: (error: unknown) => string | undefined },
  ): ReadableStream<Uint8Array>;
  export function decodeReply(body: string | FormData, manifest: unknown): Promise<unknown>;
}

// The original isolated RSC probe uses the Node decoder without Server Functions; the
// Server's "use cache" encodes arguments and results with its reply encoder.
declare module "react-server-dom-webpack/client.node" {
  export function encodeReply(value: unknown): Promise<string | FormData>;
  export function createFromNodeStream(
    stream: import("node:stream").Readable,
    manifest: {
      moduleMap: Record<string, Record<string, { id: string; chunks: string[]; name: string }>>;
      moduleLoading: null;
      serverModuleMap: null;
    },
  ): PromiseLike<unknown>;
}
