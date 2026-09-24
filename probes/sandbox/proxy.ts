/**
 * The host's egress proxy: the only address a sandboxed child may reach (Seatbelt cannot
 * filter by host name). It serves HTTP forward requests (absolute-form) and CONNECT
 * tunnels, and applies the granted host list before dialling anything. The child never
 * resolves names: DNS happens here, after the check, so a name is checked once.
 */
import { connect, createServer, type Socket } from "node:net";
import { hostAllowed } from "./capabilities";

const HTTP_PORT = 80;
const HTTPS_PORT = 443;
const MAX_HEAD_BYTES = 16_384;

export type ProxyDecision = { method: string; host: string; port: number; allowed: boolean };

export async function startProxy(options: {
  allow: readonly string[];
  /** Name → address used to dial; the probe maps fictitious names to 127.0.0.1. */
  resolve?: (host: string) => string;
  /** A unix socket path (bind-mounted into a Linux sandbox) instead of a loopback port. */
  path?: string;
}) {
  const decisions: ProxyDecision[] = [];
  const sockets = new Set<Socket>();
  const track = (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    return s;
  };
  const server = createServer((client) => {
    track(client);
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > MAX_HEAD_BYTES) client.destroy();
        return;
      }
      client.off("data", onData);
      const text = head.subarray(0, end).toString("latin1");
      const rest = head.subarray(end + "\r\n\r\n".length);
      const [line = "", ...headers] = text.split("\r\n");
      const [method = "", target = "", version = "HTTP/1.1"] = line.split(" ");
      let host: string, port: number, forwardLine: string | undefined;
      if (method === "CONNECT") {
        const at = target.lastIndexOf(":");
        host = target.slice(0, at);
        port = Number(target.slice(at + 1));
      } else {
        // A forward request names its absolute URL; anything else is not proxy traffic.
        let url: URL;
        try {
          url = new URL(target);
        } catch {
          client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
          return;
        }
        host = url.hostname;
        port = url.port ? Number(url.port) : url.protocol === "https:" ? HTTPS_PORT : HTTP_PORT;
        forwardLine = `${method} ${url.pathname}${url.search} ${version}`;
      }
      const allowed = Number.isInteger(port) && hostAllowed(options.allow, host, port);
      decisions.push({ method, host, port, allowed });
      if (!allowed) {
        client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
      }
      const upstream = track(connect({ host: options.resolve?.(host) ?? host, port }));
      upstream.on("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
      client.on("error", () => upstream.destroy());
      upstream.on("connect", () => {
        if (forwardLine === undefined) client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        else {
          // Hop-by-hop proxy headers stay here.
          const kept = headers.filter((h) => !/^proxy-/i.test(h));
          upstream.write(`${[forwardLine, ...kept].join("\r\n")}\r\n\r\n`);
        }
        if (rest.length) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    };
    client.on("data", onData);
    client.on("error", () => {});
  });
  await new Promise<void>((done) =>
    options.path === undefined
      ? server.listen(0, "127.0.0.1", done)
      : server.listen(options.path, done),
  );
  const address = server.address();
  return {
    port: address && typeof address !== "string" ? address.port : 0,
    decisions,
    stop: () =>
      new Promise<void>((done) => {
        for (const s of sockets) s.destroy();
        server.close(() => done());
      }),
  };
}
