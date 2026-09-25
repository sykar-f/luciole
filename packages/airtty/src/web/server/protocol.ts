/**
 * What a page and its in-browser Server (a SharedWorker, docs/WEB.md decision 2) say over
 * a MessagePort: HTTP, one request per id. A response streams as `head`, `chunk`s, then
 * `end` or `error`, so a live response flows as it does over the network; the page may
 * `cancel`. Both sides validate what they receive.
 */
import * as z from "zod/mini";

const Headers = z.array(z.tuple([z.string(), z.string()]));
export const PageMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("request"),
    id: z.number(),
    method: z.string(),
    /** Path and query: the Server has no host of its own. */
    path: z.string(),
    headers: Headers,
    body: z.optional(z.instanceof(ArrayBuffer)),
  }),
  z.object({ type: z.literal("cancel"), id: z.number() }),
]);
export type PageMessage = z.infer<typeof PageMessage>;

export const ServerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("head"), id: z.number(), status: z.number(), headers: Headers }),
  z.object({ type: z.literal("chunk"), id: z.number(), bytes: z.instanceof(Uint8Array) }),
  z.object({ type: z.literal("end"), id: z.number() }),
  z.object({ type: z.literal("error"), id: z.number(), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/** The end of a MessagePort both sides use: a SharedWorker's port, or a dedicated Worker. */
export type Port = {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  start?(): void;
};
