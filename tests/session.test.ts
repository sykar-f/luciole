import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "../packages/luciole/src/restore";
import { execute } from "./helpers";
import {
  ORPHAN_RETENTION_MS,
  SAVE_DELAY_MS,
  openSession,
  sessionDirectory,
} from "../packages/luciole/src/session";

let state: string;
beforeEach(async () => {
  state = await mkdtemp(join(tmpdir(), "luciole-session-"));
});
afterEach(async () => {
  await rm(state, { recursive: true, force: true });
});
const env = () => ({ XDG_STATE_HOME: state });
const server = "ssh://alice@notes.example.com";
const typed: Session = {
  index: 1,
  entries: [
    { href: "/", fields: {} },
    {
      href: "/notes/1",
      fields: { "note/text": "abc" },
      focus: "note/text",
      scroll: { "note/preview": 4 },
    },
  ],
};
/** The pid of a process that has exited: what a crashed Client leaves in its file. */
const deadPid = async () => (await execute([process.execPath, "-e", ""])).pid;
/** Rewrites a session file as a Client with `pid`, last written `age` ago, would have. */
async function leftBy(file: string, pid: number, age = 0) {
  const text = await Bun.file(file).text();
  await Bun.write(
    file,
    text.replace(/"pid":\d+,"updatedAt":\d+/, `"pid":${pid},"updatedAt":${Date.now() - age}`),
  );
}
const files = async () =>
  (await readdir(sessionDirectory("notes", env()))).filter((f) => f.endsWith(".json"));

test("a supervised Client reopens its own session, private to the user", async () => {
  const first = openSession({ name: "notes", server, id: "dev-1", env: env() });
  expect(first.restored).toBeUndefined();
  first.flush(typed);
  const file = join(sessionDirectory("notes", env()), "dev-1.json");
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect((await stat(sessionDirectory("notes", env()))).mode & 0o777).toBe(0o700);
  // After a rebuild the dev URL changed; the id alone names the session.
  const again = openSession({
    name: "notes",
    server: "http://127.0.0.1:4242",
    id: "dev-1",
    env: env(),
  });
  expect(again.restored).toEqual(typed);
});

test("after a crash the next Client takes the newest session left for the same Server", async () => {
  const empty: Session = { index: 0, entries: [{ href: "/", fields: {} }] };
  const dir = sessionDirectory("notes", env());
  for (const [id, target, session, age] of [
    ["older", server, empty, 2],
    ["newer", server, typed, 1],
    ["elsewhere", "http://elsewhere", typed, 0],
  ] as const) {
    openSession({ name: "notes", server: target, id, env: env() }).flush(session);
    // Each of them died, `age` ms ago.
    await leftBy(join(dir, `${id}.json`), await deadPid(), age);
  }
  expect(openSession({ name: "notes", server, env: env() }).restored).toEqual(typed);
  // Two Clients never share one: the next takes the other, a third finds none left
  // (another Server's session is not offered).
  expect(openSession({ name: "notes", server, env: env() }).restored).toEqual(empty);
  expect(openSession({ name: "notes", server, env: env() }).restored).toBeUndefined();
});

test("a running Client's session is never taken", async () => {
  const running = openSession({ name: "notes", server, env: env() });
  running.flush(typed);
  expect(openSession({ name: "notes", server, env: env() }).restored).toBeUndefined();
});

test("quitting on purpose deletes the session; writes wait for a pause", async () => {
  const session = openSession({ name: "notes", server, id: "quit", env: env() });
  session.schedule(typed);
  expect(await files()).toEqual([]);
  await Bun.sleep(SAVE_DELAY_MS + 50);
  expect(await files()).toEqual(["quit.json"]);
  session.remove();
  expect(await files()).toEqual([]);
});

test("old or unreadable sessions are not restored", async () => {
  const dir = sessionDirectory("notes", env());
  const stale = openSession({ name: "notes", server, id: "stale", env: env() });
  stale.flush(typed);
  await leftBy(join(dir, "stale.json"), await deadPid(), ORPHAN_RETENTION_MS + 1);
  await Bun.write(join(dir, "broken.json"), "{");
  expect(openSession({ name: "notes", server, env: env() }).restored).toBeUndefined();
  expect(await files()).not.toContain("stale.json");
});
