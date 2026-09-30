/**
 * First module of the in-browser Server (`server-worker.js`, docs/WEB.md § 3), before the
 * application's Server code: Node's globals, async context for every store the Server
 * reads across awaits (W6), a global AsyncLocalStorage for React's request storage, the
 * part of `Bun` a Worker can offer, the stored databases read before any opens (W9), and
 * the site's environment and files (seed.ts). Tabs are accepted first (accept.ts).
 */
import "./accept";
import "../node/process";
import { AsyncLocalStorage, install } from "../async-context/storage";
import { configureDatabases } from "../node/bun-sqlite";
import { bunInWorker } from "../node/bun";
import { readSnapshots } from "./snapshots";
import { applySeed, SEED_FILE } from "./seed";

install();
Object.defineProperty(globalThis, "AsyncLocalStorage", { value: AsyncLocalStorage });
Object.defineProperty(globalThis, "Bun", { value: bunInWorker });

/** The application's name, which the page gives its Worker: where its data is kept. */
const name: unknown = Reflect.get(globalThis, "name");
export const application = typeof name === "string" && name ? name : "luciole";
configureDatabases(await readSnapshots(application));
await applySeed(new URL(SEED_FILE, location.href));
