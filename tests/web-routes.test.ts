import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ABI_KEY } from "../packages/airtty/src/abi";
import { WebOrigin, webAccess, WEB_PATH } from "../packages/airtty/src/web-routes";

const ORIGIN = "https://notes.example.com";
const directory = mkdtempSync(join(tmpdir(), "airtty-web-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
writeFileSync(join(directory, "web-runtime.json"), JSON.stringify({ abi: ABI_KEY }));
writeFileSync(join(directory, "index.html"), "<!doctype html>");
writeFileSync(join(directory, "secret.txt"), "not served");

const request = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  new Request(`${ORIGIN}${path}`, { method, headers });

test("without a declared origin, every browser origin is refused and no page is served", () => {
  const web = webAccess(directory, undefined);
  expect(web.admits(request("/render"))).toBe(true);
  expect(web.admits(request("/render", { origin: ORIGIN, host: "notes.example.com" }))).toBe(false);
  expect(web.serve(request(WEB_PATH), new URL(`${ORIGIN}${WEB_PATH}`))).toBeUndefined();
});

test("the declared origin is admitted only with its own Host", () => {
  const web = webAccess(directory, ORIGIN);
  const own = { origin: ORIGIN, host: "notes.example.com" };
  expect(web.admits(request("/action", own, "POST"))).toBe(true);
  // A page on another origin, and a DNS-rebound one naming itself in Host.
  expect(web.admits(request("/action", { ...own, origin: "https://evil.example" }, "POST"))).toBe(
    false,
  );
  expect(web.admits(request("/action", { ...own, host: "evil.example" }, "POST"))).toBe(false);
  expect(
    web.admits(
      request("/action", { origin: "https://evil.example", host: "evil.example" }, "POST"),
    ),
  ).toBe(false);
});

test("the page's files are served, nothing else in the directory", async () => {
  const web = webAccess(directory, ORIGIN);
  const serve = (path: string) => web.serve(request(path), new URL(`${ORIGIN}${path}`));
  expect(serve("/")?.headers.get("location")).toBe(WEB_PATH);
  const page = serve(WEB_PATH);
  expect(page?.headers.get("content-type")).toStartWith("text/html");
  expect(await page?.text()).toBe("<!doctype html>");
  expect(serve(`${WEB_PATH}secret.txt`)).toBeUndefined();
  expect(serve(`${WEB_PATH}../web-runtime.json`)).toBeUndefined();
  expect(web.serve(request(WEB_PATH, {}, "POST"), new URL(`${ORIGIN}${WEB_PATH}`))).toBeUndefined();
});

test("a declared origin needs a runtime built for this ABI", () => {
  const empty = mkdtempSync(join(tmpdir(), "airtty-web-empty-"));
  try {
    expect(() => webAccess(empty, ORIGIN)).toThrow("airtty build --web");
    writeFileSync(join(empty, "web-runtime.json"), JSON.stringify({ abi: "0-other" }));
    expect(() => webAccess(empty, ORIGIN)).toThrow("runtime ABI 0-other");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("AIRTTY_WEB_ORIGIN is an origin, not a URL", () => {
  expect(WebOrigin.safeParse(ORIGIN).success).toBe(true);
  expect(WebOrigin.safeParse("http://127.0.0.1:3000").success).toBe(true);
  expect(WebOrigin.safeParse(`${ORIGIN}/`).success).toBe(false);
  expect(WebOrigin.safeParse(`${ORIGIN}/app`).success).toBe(false);
  expect(WebOrigin.safeParse("notes.example.com").success).toBe(false);
});
