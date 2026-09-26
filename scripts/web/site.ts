/**
 * What the web journeys share: an application's `.airtty/web/` served as a static host
 * would (`--web-local`, docs/WEB.md), and the screen xterm.js draws into the DOM, as text.
 */
import { join } from "node:path";

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  cjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  wasm: "application/wasm",
  map: "application/json",
  scm: "text/plain; charset=utf-8",
};

/** `site` over HTTP, as any static host serves it. */
export function serveSite(site: string) {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url).pathname;
      const path = url.endsWith("/") ? `${url}index.html` : url;
      const file = Bun.file(join(site, path));
      if (path.includes("..") || !(await file.exists()))
        return new Response("Not found", { status: 404 });
      const type = TYPES[path.slice(path.lastIndexOf(".") + 1)] ?? "application/octet-stream";
      return new Response(file, { headers: { "content-type": type } });
    },
  });
}

/** The rows xterm.js renders into the DOM, as text. */
export const SCREEN = `[...document.querySelectorAll(".xterm-rows > div")].map((row) => row.textContent).join("\\n")`;
export const shows = (text: string) =>
  `(${SCREEN}).includes(${JSON.stringify(text)}) && (${SCREEN})`;
export const rowWith = (...texts: string[]) =>
  `[...document.querySelectorAll(".xterm-rows > div")].some((row) => ${texts.map((t) => `row.textContent.includes(${JSON.stringify(t)})`).join(" && ")})`;
