declare module "react-server-dom-webpack/client.browser" {
  export function createFromReadableStream(stream: ReadableStream, options: any): any;
  export function encodeReply(value: any): Promise<string | FormData>;
  export function createServerReference(
    id: string,
    callServer: (id: string, args: any[]) => Promise<any>,
  ): any;
}
declare module "react-server-dom-webpack/server.node" {
  export function registerClientReference<T>(value: T, id: string, name: string): T;
  export function registerServerReference<T>(value: T, id: string, name: string): T;
  export function renderToPipeableStream(
    model: any,
    manifest: any,
    options?: any,
  ): { pipe(stream: any): void; abort(): void };
  export function decodeReply(body: string | FormData, manifest: any): Promise<any>;
}

// The original isolated RSC probe uses the Node decoder without Server Functions.
declare module "react-server-dom-webpack/client.node" {
  export function createFromNodeStream<T = import("react").ReactNode>(
    stream: import("node:stream").Readable,
    manifest: {
      moduleMap: Record<string, Record<string, { id: string; chunks: string[]; name: string }>>;
      moduleLoading: null;
      serverModuleMap: null;
    },
  ): PromiseLike<T>;
}
