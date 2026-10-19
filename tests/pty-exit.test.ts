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

/** macOS revokes the slave when its session leader exits; the tail must arrive first. */
test("a direct program's last UTF-8 bytes arrive before its exit code", async () => {
  const tail = "é終🙂".repeat(512) + "[last-byte]";
  const chunks: Buffer[] = [];
  let report!: (snapshot: { code: number | null; bytes: Buffer }) => void;
  const exited = new Promise<{ code: number | null; bytes: Buffer }>((resolve) => {
    report = resolve;
  });
  const pty = spawnPty({
    command: [
      process.execPath,
      "-e",
      `import {writeSync} from 'node:fs'; writeSync(1, Buffer.from(${JSON.stringify(tail)})); process.exit(23);`,
    ],
    cols: 80,
    rows: 24,
    onData: (data) => chunks.push(Buffer.from(data)),
    // Snapshot here: later output must not make an early exit notification look correct.
    onExit: (code) => report({ code, bytes: Buffer.concat(chunks) }),
  });
  try {
    const snapshot = await exited;
    expect(snapshot.code).toBe(23);
    expect(snapshot.bytes).toEqual(Buffer.from(tail));
  } finally {
    pty.kill();
  }
});
