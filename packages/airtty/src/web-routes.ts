/**
 * The web runtime a Server serves to browsers (docs/WEB.md, § 3 and decision 1): the page
 * under `/_airtty/web/`, on the one origin the operator declares (`AIRTTY_WEB_ORIGIN`),
 * and the rule that lets that origin's requests through while every other browser origin
 * stays refused.
 *
 * Opt-in twice: the build copied a web runtime (`airtty build --web`, `.airtty/web/`), and
 * the environment declares the origin. Either one alone serves nothing.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ABI_KEY } from "./abi";

export const WEB_PATH = "/_airtty/web/";
const FILES: Record<string, string> = {
  "index.html": "text/html; charset=utf-8",
  "runtime.js": "text/javascript; charset=utf-8",
  "runtime.js.map": "application/json",
  "opentui.wasm": "application/wasm",
  "xterm.css": "text/css; charset=utf-8",
};
const STATUS = { found: 302, forbidden: 403 } as const;
const RuntimeInfo = z.object({ abi: z.string() });

/** `https://host[:port]`, exactly: what browsers send as `Origin`. */
export const WebOrigin = z
  .string()
  .refine((value) => URL.canParse(value) && new URL(value).origin === value, {
    message: "must be an origin: scheme, host and port, without a path",
  });

export type WebAccess = {
  /** A browser's request (it has `Origin`) may run: it comes from the declared origin. */
  admits(req: Request): boolean;
  /** The page's files; `undefined` when `url` is not one of them. */
  serve(req: Request, url: URL): Response | undefined;
};

/** Browser origins refused, no page: a Server without the web target. */
const closed: WebAccess = {
  admits: (req) => !req.headers.has("origin"),
  serve: () => undefined,
};

/**
 * What the Server lets browsers do. `origin` is only honored with a runtime built for this
 * Server's ABI: a page that cannot open the application is refused at startup, not in it.
 */
export function webAccess(directory: string | undefined, origin: string | undefined): WebAccess {
  if (!origin) return closed;
  if (!directory || !existsSync(join(directory, "web-runtime.json")))
    throw new Error(
      "AIRTTY_WEB_ORIGIN is set but this build has no web runtime: build with airtty build --web",
    );
  const info = RuntimeInfo.parse(
    JSON.parse(readFileSync(join(directory, "web-runtime.json"), "utf8")),
  );
  if (info.abi !== ABI_KEY)
    throw new Error(
      `${directory} was built for runtime ABI ${info.abi}, this Server has ${ABI_KEY}`,
    );
  const host = new URL(origin).host;
  return {
    // Origin and Host both: a DNS-rebound page sends its own Host, never the declared one.
    admits: (req) =>
      !req.headers.has("origin") ||
      (req.headers.get("origin") === origin && req.headers.get("host") === host),
    serve(req, url) {
      if (req.method !== "GET") return undefined;
      if (url.pathname === "/" || url.pathname === WEB_PATH.slice(0, -1))
        return new Response(null, { status: STATUS.found, headers: { location: WEB_PATH } });
      if (!url.pathname.startsWith(WEB_PATH)) return undefined;
      const name = url.pathname.slice(WEB_PATH.length) || "index.html";
      const type = FILES[name];
      if (!type) return undefined;
      return new Response(Bun.file(join(directory, name)), {
        headers: {
          "content-type": type,
          "cache-control": "no-cache",
          // The page runs the application's code: nothing else may frame or script it.
          "x-content-type-options": "nosniff",
          "x-frame-options": "SAMEORIGIN",
        },
      });
    },
  };
}
