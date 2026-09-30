/**
 * Host-side forwarders, for a Linux sandbox whose child reaches the host only through
 * the relays of luciole-sandbox (a Unix socket each) or, without namespaces, through TCP
 * ports it may connect to: the application's Server exposed on the side it lacks.
 */
import { connect, createServer, type Socket } from "node:net";

export type Target = { port: number } | { path: string };
export type Bridge = {
  /** The loopback port it listens on, when it listens on TCP. */
  port: number;
  close(): Promise<void>;
};
const dial = (target: Target) =>
  "path" in target
    ? connect({ path: target.path })
    : connect({ host: "127.0.0.1", port: target.port });

/** Listens on `listen` (a Unix socket path, or a loopback port when undefined), forwarding to `target`. */
export async function bridge(target: Target, listen?: string): Promise<Bridge> {
  const sockets = new Set<Socket>();
  const track = (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("error", () => s.destroy());
    return s;
  };
  const server = createServer((client) => {
    track(client);
    const upstream = track(dial(target));
    client.pipe(upstream);
    upstream.pipe(client);
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  await new Promise<void>((done) =>
    listen === undefined ? server.listen(0, "127.0.0.1", done) : server.listen(listen, done),
  );
  const address = server.address();
  return {
    port: address && typeof address !== "string" ? address.port : 0,
    close: () =>
      new Promise<void>((done) => {
        for (const s of sockets) s.destroy();
        server.close(() => done());
      }),
  };
}
