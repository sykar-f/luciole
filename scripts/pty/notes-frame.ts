/**
 * The README's frame: built Notes, separate Server and Client processes, a real 140×40
 * PTY, the welcome note as the Server sent it. Writes docs/notes-pty-frame.txt.
 *   bun scripts/pty/notes-frame.ts
 */
import { join } from "node:path";
import { drive } from "./driver";
import { BUN, ROOT, build, example, startServer, temporaryDirectory } from "./harness";

const APP = example("notes");

build(APP);
using directory = temporaryDirectory("notes-frame-");
await using server = await startServer(APP, {
  NOTES_DB: join(directory.path, "notes.sqlite"),
});
await using t = await drive({
  command: [BUN, join(APP, ".luciole/client/index.js"), "--url", server.url],
  cols: 140,
  rows: 40,
  // A private state directory: the session file of this Client never reaches $HOME.
  env: { NODE_ENV: "production", XDG_STATE_HOME: join(directory.path, "state") },
});

await t.waitFor("Welcome to Notes");
await t.click("Welcome to Notes");
await t.waitFor("Getting around");
await Bun.write(join(ROOT, "docs/notes-pty-frame.txt"), await t.snapshot());
await t.quit();
