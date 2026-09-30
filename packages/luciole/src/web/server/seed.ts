/**
 * `server-seed.json`, next to `server-worker.js` when the site has one (docs/WEB.md): what
 * a Server started from a shell would find around it. `env` joins `process.env` before
 * the application's Server code reads it; `files` is the read-only snapshot `node:fs`
 * answers from (../node/files.ts). A site without one runs as before.
 */
import * as z from "zod/mini";
import { configureFiles } from "../node/files";

export const SEED_FILE = "server-seed.json";
const HTTP_NOT_FOUND = 404;

const Seed = z.object({
  env: z.optional(z.record(z.string(), z.string())),
  files: z.optional(
    z.array(
      z.object({
        path: z.string(),
        kind: z.enum(["file", "directory"]),
        size: z.number(),
        mtimeMs: z.number(),
        content: z.optional(z.string()),
      }),
    ),
  ),
});

export async function applySeed(url: URL) {
  const response = await fetch(url);
  if (response.status === HTTP_NOT_FOUND) return;
  if (!response.ok) throw new Error(`${url.href}: ${response.status} ${response.statusText}`);
  const seed = Seed.safeParse(await response.json());
  if (!seed.success) throw new Error(`${url.href}: ${z.prettifyError(seed.error)}`);
  Object.assign(process.env, seed.data.env);
  configureFiles(seed.data.files ?? []);
}
