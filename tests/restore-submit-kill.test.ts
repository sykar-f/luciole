import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { sessionDirectory } from "../packages/core/src/session";
import {
  BUILD_TEST_MS,
  launch,
  leaveCrashedSession,
  present,
  privateBuild,
  until,
} from "./helpers";

const built = await privateBuild("examples/notes");
// What a Client keeps of the note's page, as src/session.ts writes it.
const SessionFile = z.object({
  pid: z.number(),
  entries: z.array(z.object({ href: z.string(), fields: z.record(z.string(), z.string()) })),
});
// Typed into the note, then sent: never in the seed, so seeing it means it was kept.
const SENT = "zqx sent once";
// Ctrl+S, the Notes binding that saves the note.
const CTRL_S = "\x13";
// DECTCEM: the terminal's cursor shown, which OpenTUI does for a focused editor only.
const CURSOR_SHOWN = "\x1b[?25h";

// macOS and util-linux spell script(1) differently; see tests/compile.test.ts. Both write
// the screen as it comes (`-t 0`, `-f`). Keys reach it through `cat`: script(1) needs a
// pipe, and Bun's is a socket it cannot set up.
const inPty = (log: string, command: string) =>
  process.platform === "darwin"
    ? `cat | /usr/bin/script -q -t 0 ${log} ${command}`
    : `cat | script -q -e -f -c '${command}' ${log}`;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test(
  "a Client killed (SIGKILL) as its submit leaves does not offer the sent text again",
  async () => {
    const run = await mkdtemp(join(tmpdir(), "luciole-submit-kill-"));
    const state = join(run, "state");
    const server = await launch(join(built.output, "server/index.js"), {
      NOTES_DB: join(run, "notes.sqlite"),
      // Only Ctrl+S sends: the test decides when the text leaves.
      NOTES_AUTOSAVE_MS: "0",
    });
    const killed = join(run, "killed");
    const sessions = sessionDirectory("notes", { XDG_STATE_HOME: state });
    // The session file a Client holds: the note's kept fields, and which process wrote them.
    const kept = () => {
      const names = existsSync(sessions) ? readdirSync(sessions) : [];
      for (const name of names.filter((n) => n.endsWith(".json"))) {
        let text: string;
        try {
          text = readFileSync(join(sessions, name), "utf8");
        } catch {
          // Claimed by the next Client meanwhile: renamed to that Client's own file.
          continue;
        }
        const file = SessionFile.parse(JSON.parse(text));
        const note = file.entries.find((e) => e.href === "/notes/1");
        if (note) return { pid: file.pid, fields: note.fields };
      }
      return undefined;
    };
    // The generated Client as `bun .luciole/client/index.js` runs it, in a terminal of its own.
    const terminals: Array<{ stdin: { end(): unknown }; exited: Promise<number> }> = [];
    const clients: number[] = [];
    const client = (log: string, preload: string[]) => {
      const command = [
        process.execPath,
        ...preload,
        join(built.directory, ".luciole/client/index.js"),
      ];
      const child = Bun.spawn(["/bin/sh", "-c", inPty(log, command.join(" "))], {
        cwd: run,
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
        env: {
          ...process.env,
          TERM: "xterm-256color",
          LUCIOLE_URL: server.url,
          XDG_STATE_HOME: state,
          // tests/kill-on-send.ts: the save the test sends, not the list Notes loads with.
          KILL_ON_ACTION: "saveNote",
          KILLED_ON_SEND: killed,
        },
      });
      terminals.push(child);
      const output = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
      const screen = () => Bun.stripANSI(output());
      const type = (keys: string) => {
        // Written to `cat` at once: neither waits on the Client.
        void child.stdin.write(keys);
        void child.stdin.flush();
      };
      return { output, screen, type };
    };
    try {
      // A Client crashed on the first note: the next one reopens it there.
      await leaveCrashedSession(state, "notes", server.url, "/notes/1");
      const first = client(join(run, "first.log"), ["--preload", resolve("tests/kill-on-send.ts")]);
      await until(() => first.screen().includes("Getting around"), BUILD_TEST_MS / 2, first.screen);
      // Return edits the note shown. Keys sent with it would reach the page before the editor
      // has the focus: the terminal's cursor, shown once it has, says when to type.
      first.type("\r");
      await until(() => first.output().includes(CURSOR_SHOWN), 10000, first.screen);
      // The typed text is kept, and written a moment later.
      first.type(SENT);
      await until(() => kept()?.fields["note/text"]?.includes(SENT) ?? false, 10000, first.screen);
      const sender = present(kept(), "the first Client's session").pid;
      clients.push(sender);

      // Sent: the Client dies as the request leaves, no handler run, nothing flushed on exit.
      first.type(CTRL_S);
      await until(() => !alive(sender), 10000, first.screen);
      expect(existsSync(killed)).toBe(true);

      // Restarted, the next Client reopens the note without the text that was sent.
      const restarted = client(join(run, "second.log"), []);
      await until(
        () => restarted.screen().includes("Getting around") && kept()?.pid !== sender,
        BUILD_TEST_MS / 2,
        restarted.screen,
      );
      const reopened = present(kept(), "the restarted Client's session");
      clients.push(reopened.pid);
      expect(reopened.fields).toEqual({});
      expect(restarted.screen()).not.toContain(SENT);
    } finally {
      // A Client gone, script(1) follows; `cat` once its input ends.
      for (const pid of clients) if (alive(pid)) process.kill(pid, "SIGKILL");
      for (const terminal of terminals) terminal.stdin.end();
      await Promise.all(terminals.map((terminal) => terminal.exited));
      await server.stop();
      await rm(run, { recursive: true, force: true });
    }
  },
  BUILD_TEST_MS,
);
