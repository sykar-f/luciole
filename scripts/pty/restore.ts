/** Production Client session: restored after kill -9 and SIGTERM, deleted when the user quits. */
import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ctrl, drive, type Driver } from "./driver";
import { BUN, example, report, sessionKeeps, startServer, temporaryDirectory } from "./harness";

const PRIVATE_FILE_MODE = 0o600;
const PERMISSION_BITS = 0o777;

using directory = temporaryDirectory("luciole-restore-");
const state = join(directory.path, "state");
const sessions = join(state, "luciole/notes/sessions");
const env = { NODE_ENV: "production", XDG_STATE_HOME: state };
await using server = await startServer(example("notes"), {
  ...env,
  NOTES_DB: join(directory.path, "notes.sqlite"),
  // Nothing saves by itself: what comes back after a crash is unsaved text.
  NOTES_AUTOSAVE_MS: "0",
  LUCIOLE_TEST: "1",
});
const start = () =>
  drive({
    command: [BUN, join(example("notes"), ".luciole/client/index.js"), "--url", server.url],
    cols: 110,
    rows: 28,
    env,
  });
const saved = () =>
  existsSync(sessions)
    ? readdirSync(sessions)
        .filter((name) => name.endsWith(".json"))
        .sort()
    : [];
/** Ctrl+E: the cursor at the end of the text, shown once editing started. */
async function edit(t: Driver) {
  t.write(ctrl("e"));
  await t.until(async () => (await t.cursor()).visible, "Ctrl+E never showed the cursor");
}

{
  await using t = await start();
  await t.waitFor("Welcome to Notes");
  await t.click("Welcome to Notes");
  await t.waitFor("Getting around");
  await edit(t);
  t.write("abc");
  await t.waitFor("abc");
  await t.until(() => sessionKeeps(sessions, "abc"), "the session never kept the text");
  assert.equal(saved().length, 1, saved().join());
  const mode = statSync(join(sessions, saved()[0] ?? "")).mode & PERMISSION_BITS;
  assert.equal(mode, PRIVATE_FILE_MODE, `session file mode ${mode.toString(8)}`);
  // A crash: nothing runs, the last write is what comes back.
  t.signal("SIGKILL");
  await t.exited();
}
{
  await using t = await start();
  await t.waitFor("abc");
  await t.waitFor("● Unsaved");
  assert.equal(saved().length, 1, saved().join());
  await edit(t);
  t.write("d");
  await t.waitFor("abcd");
  // A signal (a closed terminal, a rebuild): the session is written before exit.
  t.signal("SIGTERM");
  assert.equal(await t.exited(), 0);
}
{
  await using t = await start();
  await t.waitFor("abcd");
  await t.waitFor("● Unsaved");
  // Quitting on purpose: nothing is offered next time.
  await t.quit();
  assert.deepEqual(saved(), []);
}
{
  await using t = await start();
  await t.waitFor("Welcome to Notes");
  assert.ok(!(await t.text()).includes("abcd"));
  await t.quit();
}

report({
  productionPTY: true,
  restoredAfterKill: true,
  restoredAfterSigterm: true,
  privateFile: true,
  deletedOnQuit: true,
});
