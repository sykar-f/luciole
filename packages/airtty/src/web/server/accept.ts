/**
 * The in-browser Server's very first module: tabs are accepted as they connect, before any
 * module with a top-level await lets the Worker's event loop run (a SharedWorker's
 * `connect` event is lost if nothing listens then).
 */
import type { Port } from "./protocol";
import { connect } from "./worker";

const isPort = (value: unknown): value is Port =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "postMessage") === "function" &&
  typeof Reflect.get(value, "addEventListener") === "function";

// A SharedWorker receives one port per tab; a dedicated Worker is its tab's port.
if ("onconnect" in globalThis)
  Reflect.set(globalThis, "onconnect", (event: MessageEvent) => {
    for (const port of event.ports) connect(port);
  });
else if (isPort(globalThis)) connect(globalThis);
