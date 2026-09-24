/**
 * The host's egress proxy: the only address a sandboxed child may reach besides its
 * Server (Seatbelt cannot filter by host name, src/sandbox/profile.ts). It serves HTTP
 * forward requests (absolute-form) and CONNECT tunnels, and checks the granted host list
 * before dialling anything. The child never resolves names: DNS happens here, after the
 * check. Started before the child, and listening until the child is gone, so no other
 * process can take its port meanwhile.
 */
import { connect, createServer, type Socket } from "node:net";

const HTTP_PORT = 80;
const MAX_HEAD_BYTES = 16_384;
const HEAD_END = "\r\n\r\n";

/** `host`, `*.suffix`, `host:port` or `*`, as `airtty.capabilities.net` lists them. */
export function hostAllowed(patterns: readonly string[], host: string, port: number) {
  const name = host.toLowerCase().replace(/\.$/, "");
  return patterns.some((pattern) => {
    const at = pattern.lastIndexOf(":");
    const patternHost = (at < 0 ? pattern : pattern.slice(0, at)).toLowerCase();
    if (at >= 0 && Number(pattern.slice(at + 1)) !== port) return false;
    if (patternHost === "*") return true;
    if (patternHost.startsWith("*.")) return name.endsWith(patternHost.slice(1));
    return name === patternHost;
  });
}

export type ProxyDecision = { method: string; host: string; port: number; allowed: boolean };
export type EgressProxy = {
  port: number;
  /** Every request seen, allowed or not (tests; a future network panel). */
  decisions: readonly ProxyDecision[];
  stop(): Promise<void>;
};

export async function startProxy(options: {
  allow: readonly string[];
  /** Name → address actually dialled (tests map fictitious names to 127.0.0.1). */
  resolve?: (host: string) => string;
}): Promise<EgressProxy> {
  const decisions: ProxyDecision[] = [];
  const sockets = new Set<Socket>();
  const track = (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    return s;
  };
  const server = createServer((client) => {
    track(client);
    client.on("error", () => {});
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf(HEAD_END);
      if (end < 0) {
        if (head.length > MAX_HEAD_BYTES) client.destroy();
        return;
      }
      client.off("data", onData);
      const [line = "", ...headers] = head.subarray(0, end).toString("latin1").split("\r\n");
      const rest = head.subarray(end + HEAD_END.length);
      const [method = "", target = "", version = "HTTP/1.1"] = line.split(" ");
      let host: string, port: number, forward: string | undefined;
      if (method === "CONNECT") {
        const at = target.lastIndexOf(":");
        host = target.slice(0, at).replace(/^\[|\]$/g, "");
        port = Number(target.slice(at + 1));
      } else {
        // A forward request names its absolute URL; anything else is not proxy traffic.
        const url = URL.parse(target);
        if (!url || url.protocol !== "http:") {
          client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
          return;
        }
        host = url.hostname.replace(/^\[|\]$/g, "");
        port = url.port ? Number(url.port) : HTTP_PORT;
        // One request per connection: the upstream is chosen by this head only, so a later
        // request on a kept-alive connection must not ride it to another host.
        const kept = headers.filter((h) => !/^(proxy-[\w-]*|connection|keep-alive):/i.test(h));
        forward = [
          `${method} ${url.pathname}${url.search} ${version}`,
          ...kept,
          "Connection: close",
        ].join("\r\n");
      }
      const allowed = Number.isInteger(port) && port > 0 && hostAllowed(options.allow, host, port);
      decisions.push({ method, host, port, allowed });
      if (!allowed) {
        client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
      }
      const upstream = track(connect({ host: options.resolve?.(host) ?? host, port }));
      upstream.on("error", () =>
        client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"),
      );
      client.on("close", () => upstream.destroy());
      upstream.on("connect", () => {
        if (forward === undefined) client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        else upstream.write(`${forward}${HEAD_END}`);
        if (rest.length) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    };
    client.on("data", onData);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The egress proxy has no port");
  return {
    port: address.port,
    decisions,
    stop: () =>
      new Promise<void>((done) => {
        for (const s of sockets) s.destroy();
        server.close(() => done());
      }),
  };
}
