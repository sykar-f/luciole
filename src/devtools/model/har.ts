import { cacheBadge, phases, rowStart, type Flags, type Row } from "./network";

/**
 * A HAR 1.2 log of the Network panel, for tools that read Chrome's exports. HAR is
 * HTTP-shaped and lossy: Server timings, chunks, causes and flags travel in `_airtty`
 * fields (custom fields start with `_`, per the spec). The raw event log, not this, is
 * what `airtty devtools --replay` reopens.
 */
const MIME = "text/x-component";
const round = (ms: number | undefined) => (ms === undefined ? -1 : Math.max(0, Math.round(ms)));

export function toHar(
  rows: readonly Row[],
  flags: ReadonlyMap<string, Flags>,
  origin = "http://airtty.invalid",
) {
  return {
    log: {
      version: "1.2",
      creator: { name: "airtty devtools", version: "1" },
      entries: rows.map((row) => {
        const p = phases(row);
        const start = rowStart(row);
        const url =
          row.kind === "render"
            ? `${origin}/render?route=${encodeURIComponent(row.target)}${row.href ? `&href=${encodeURIComponent(row.href)}` : ""}`
            : `${origin}/action#${row.target}`;
        const receive =
          p.end !== undefined && p.response !== undefined ? p.end - p.response : undefined;
        return {
          startedDateTime: new Date(start).toISOString(),
          time: round((p.end ?? 0) || undefined),
          request: {
            method: row.kind === "render" ? "GET" : "POST",
            url,
            httpVersion: "HTTP/1.1",
            headers: row.callId ? [{ name: "x-airtty-call", value: row.callId }] : [],
            queryString: [],
            cookies: [],
            headersSize: -1,
            bodySize: -1,
          },
          response: {
            status: row.client.status ?? row.server.status ?? 0,
            statusText: "",
            httpVersion: "HTTP/1.1",
            headers: [],
            cookies: [],
            content: { size: row.client.bytes, mimeType: MIME },
            redirectURL: "",
            headersSize: -1,
            bodySize: row.client.bytes,
          },
          cache: {},
          timings: {
            blocked: round(p.queued),
            dns: -1,
            connect: -1,
            send: 0,
            wait: round(p.ttfb),
            receive: round(receive),
          },
          _airtty: {
            callId: row.callId,
            kind: row.kind,
            target: row.target,
            cause: row.cause,
            source: row.source,
            cache: cacheBadge(row),
            cacheOps: row.cache,
            server: row.server,
            chunks: row.client.chunks,
            error: row.client.error ?? row.server.error,
            ...flags.get(row.key),
          },
        };
      }),
    },
  };
}
