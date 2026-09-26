/**
 * The Node globals OpenTUI and React read in a page. `process`: an environment, a platform, the
 * events it listens to (warnings, uncaught errors, which the page reports itself) and
 * stdio objects that are never the renderer's streams, so `stream === process.stdout`
 * stays false as it must for a terminal it does not own.
 */
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import "./buffer-base64url";

const NS_PER_MS = 1e6;
const NS_PER_S = 1e9;

class PageProcess extends EventEmitter {
  env: Record<string, string | undefined> = { NODE_ENV: "production" };
  platform = "browser";
  arch = "wasm32";
  argv: string[] = [];
  versions: Record<string, string> = {};
  exitCode: number | undefined = undefined;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = new EventEmitter();
  cwd = () => "/";
  nextTick = (callback: (...args: unknown[]) => void, ...args: unknown[]) =>
    queueMicrotask(() => callback(...args));
  hrtime = Object.assign(
    (previous?: readonly [number, number]) => {
      const ns = performance.now() * NS_PER_MS;
      const now: [number, number] = [Math.floor(ns / NS_PER_S), Math.floor(ns % NS_PER_S)];
      return previous ? [now[0] - previous[0], now[1] - previous[1]] : now;
    },
    { bigint: () => BigInt(Math.round(performance.now() * NS_PER_MS)) },
  );
  memoryUsage = () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 });
  exit = (code = 0) => {
    this.exitCode = code;
    this.emit("exit", code);
  };
}

if (typeof globalThis.process === "undefined")
  Object.defineProperty(globalThis, "process", { value: new PageProcess(), configurable: true });
// Node's name for the global object (OpenTUI's console capture replaces `global.console`).
if (!("global" in globalThis))
  Object.defineProperty(globalThis, "global", { value: globalThis, configurable: true });
// Node's Buffer global, which OpenTUI's input parser and streams use unimported.
if (!("Buffer" in globalThis))
  Object.defineProperty(globalThis, "Buffer", { value: Buffer, configurable: true });
