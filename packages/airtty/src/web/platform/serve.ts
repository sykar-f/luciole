/**
 * `serve()` in the in-browser Server (src/serve.ts): the handler of src/server.ts answers
 * the tabs over their ports (server/worker.ts) instead of listening. There is no
 * environment, no socket and no lifetime to manage: the Worker lives as long as a tab.
 * A Server Function's writes are stored before its answer leaves (docs/WEB.md, decision 2).
 */
import { createHandler, type AuthConfig, type ServerConfig } from "../../server";
import { databaseImages } from "../node/bun-sqlite";
import { application } from "../server/setup";
import { writeSnapshot } from "../server/snapshots";
import { serveWith } from "../server/worker";

/** The browser's own user: the page and its Server share one origin and one person. */
const LOCAL_USER: AuthConfig = { authenticate: () => ({ userId: "local" }) };

let saving = Promise.resolve();
/** Every open database, stored whole, one save after the other. */
const persist = () =>
  (saving = saving.then(async () => {
    for (const [name, bytes] of databaseImages()) await writeSnapshot(application, name, bytes);
  }));

export function serve(config: ServerConfig) {
  const handler = createHandler(config, { auth: config.auth ?? LOCAL_USER });
  serveWith(async (request) => {
    const response = await handler(request);
    if (new URL(request.url).pathname === "/action") await persist();
    return response;
  });
}
