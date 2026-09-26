/**
 * The `Bun` global in the in-browser Server (docs/WEB.md, W9): what applications' Server
 * code calls of it that a Worker can do (`sleep`, `env`, `nanoseconds`, a SHA-256
 * `CryptoHasher`). Anything else says
 * it is unavailable here, rather than failing as an unknown name. The page has no `Bun`:
 * libraries there tell Bun from a browser by it.
 */
import { Sha256Hasher } from "./sha256";

const NS_PER_MS = 1e6;
const available: Record<string, unknown> = {
  CryptoHasher: Sha256Hasher,
  sleep: (until: number | Date) =>
    new Promise<void>((resolve) =>
      setTimeout(resolve, typeof until === "number" ? until : until.getTime() - Date.now()),
    ),
  env: globalThis.process.env,
  nanoseconds: () => Math.round(performance.now() * NS_PER_MS),
  version: "browser",
};

export const bunInWorker = new Proxy(available, {
  get(target, key) {
    if (typeof key !== "string" || key in target) return target[String(key)];
    throw new Error(`Bun.${key} is not available in the browser runtime`);
  },
});
