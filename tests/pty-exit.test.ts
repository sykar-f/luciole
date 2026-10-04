/**
 * What `spawnPty` does when its program exits on Linux (src/vt/pty.ts): it reads what the
 * program left in the PTY before closing it, but only so far, so that a job the program
 * left behind, still writing to the PTY, cannot hold the Client.
 */
import { expect, test } from "bun:test";
import { spawnPty } from "../packages/core/src/vt/pty";
import { execute } from "./helpers";

test.if(process.platform === "linux")(
  "the exit is reported while a job the program left behind still writes",
  async () => {
    let bytes = 0;
    let session = 0;
    const exited = new Promise<number | null>((done) => {
      const pty = spawnPty({
        // The job ignores the hangup the shell's exit sends: it writes until the PTY closes.
        // The shell exits once the job has filled the PTY, which `yes` does at once.
        command: ["/bin/sh", "-c", "(trap '' HUP; exec yes) & sleep 0.2"],
        cols: 80,
        rows: 24,
        // A Client's emulator takes time with each chunk: `yes` writes faster than this.
        // Simulated time, not a wait: a slow reader, which the PTY must not wait out.
        onData: (data) => {
          bytes += data.length;
          Bun.sleepSync(1);
        },
        onExit: done,
      });
      session = pty.pid;
    });
    try {
      expect(await exited).toBe(0);
      expect(bytes).toBeGreaterThan(0);
    } finally {
      // The program leads its session: whatever of it is left.
      await execute(["pkill", "-KILL", "-s", String(session)]);
    }
  },
);
