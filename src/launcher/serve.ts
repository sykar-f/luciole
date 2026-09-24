/**
 * Runs a built Server (`.airtty/server/index.js`) for the launcher:
 * `bun --conditions=react-server serve.ts <index.js> [--attached]`.
 * The Server reads its address from its environment (AIRTTY_SOCKET).
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ATTACHED_FLAG, exitWithStdin } from "./attach";

const [entry, ...flags] = process.argv.slice(2);
if (!entry) throw new Error("Usage: serve.ts <server index.js> [--attached]");
if (flags.includes(ATTACHED_FLAG)) exitWithStdin();
await import(pathToFileURL(resolve(entry)).href);
