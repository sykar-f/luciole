/**
 * What the web journeys share: an application's `.luciole/web/` served as a static host
 * would (`--web-local`, docs/WEB.md), and the screen the runtime shows, as text.
 */
import { join } from "node:path";
import { z } from "zod";
import type { Browser } from "./cdp";

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

/**
 * The screen as the runtime reads it from its buffer (docs/WEB.md, "Page embarquée",
 * `lucioleScreen`), as text: the GPU renderer leaves nothing in the DOM to read.
 */
export const SCREEN = `lucioleScreen().join("\\n")`;
export const shows = (text: string) =>
  `(${SCREEN}).includes(${JSON.stringify(text)}) && (${SCREEN})`;
export const rowWith = (...texts: string[]) =>
  `lucioleScreen().some((row) => ${texts.map((t) => `row.includes(${JSON.stringify(t)})`).join(" && ")})`;
/**
 * The middle of the first cell of `text` on the screen, as a point for `Browser.clickAt`:
 * a click on the words a user would point at. From the screen element's box and the grid.
 * If absent, returns the screen rows instead; `clickOn` reports them outside the page.
 */
export const cellOf = (text: string) =>
  `(() => { const rows = lucioleScreen(); const y = rows.findIndex((row) => row.includes(${JSON.stringify(text)})); if (y < 0) return { rows }; const columns = lucioleCells()[0].length; const box = document.querySelector(".xterm-screen").getBoundingClientRect(); return { x: box.x + ((rows[y].indexOf(${JSON.stringify(text)}) + 0.5) * box.width) / columns, y: box.y + ((y + 0.5) * box.height) / rows.length }; })()`;
const Cell = z.union([
  z.object({ x: z.number(), y: z.number() }),
  z.object({ rows: z.array(z.string()) }),
]);

/** A checked label click: page exceptions would lose their detail at the CDP boundary. */
export async function clickOn(browser: Pick<Browser, "evaluate" | "clickAt">, text: string) {
  const cell = Cell.parse(await browser.evaluate(cellOf(text)));
  if ("rows" in cell)
    throw new Error(
      `The screen has no label ${JSON.stringify(text)}\n--- screen\n${cell.rows.join("\n")}`,
    );
  await browser.clickAt(`(${JSON.stringify(cell)})`);
}

/** How many colours the first row showing `text` is drawn in: 0 without such a row. */
export const coloursOfRow = (text: string) =>
  `(() => { const y = lucioleScreen().findIndex((row) => row.includes(${JSON.stringify(text)})); return y < 0 ? 0 : new Set(lucioleCells()[y].filter((cell) => cell).map((cell) => cell.split("|")[1])).size; })()`;
