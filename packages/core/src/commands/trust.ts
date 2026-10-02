import { originOf, pinPublisher } from "../generic/origin";
import type { Command } from "./command";

/**
 * `luciole trust <origin> <fingerprint>`: pins a publisher key for an origin opened by URL,
 * out of band, when its publisher confirms a new key; replaces the pinned one.
 */
export const trust: Command = {
  usage: "trust <server url> <SHA256:fingerprint>",
  run({ args }) {
    const [, url, fingerprint] = args;
    if (!url || !fingerprint) throw new Error("Usage: luciole trust <server url> <SHA256:…>");
    const origin = originOf(url);
    pinPublisher(origin, fingerprint);
    console.log(`${origin}: publisher key ${fingerprint} pinned`);
    return Promise.resolve();
  },
};
