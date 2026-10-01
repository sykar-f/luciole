/**
 * The slave path `spawnPty` hands to a command function (src/vt/pty.ts): the one device
 * the PTY's program gets, found from the descriptor, whatever else the host is doing.
 * PTYs are a machine-wide resource other tests and sessions share: at most HELD are open
 * at once here.
 */
import { test, expect } from "bun:test";
import { closeSync, openSync, statSync } from "node:fs";
import { spawnPty } from "../packages/luciole/src/vt/pty";

const IN_A_ROW = 200;
const HELD = 8;
const SLAVE_PATH = /^\/dev\/(?:ttys\d+|pts\/\d+)$/;
const TEST_MS = 60_000;

/** A PTY running `sleep`, and the slave path it was given; resolves once it is hung up. */
function open() {
  let tty = "";
  let exited!: Promise<void>;
  const pty = spawnPty({
    command: (path) => {
      tty = path;
      return ["/bin/sleep", "30"];
    },
    cols: 80,
    rows: 24,
    onData: () => {},
    onExit: () => {},
  });
  exited = new Promise<void>((done) => {
    const timer = setInterval(() => {
      try {
        process.kill(pty.pid, 0);
      } catch {
        clearInterval(timer);
        done();
      }
    }, 5);
  });
  return {
    tty,
    close: async () => {
      pty.kill();
      await exited;
    },
  };
}

test(
  "the slave of each of many PTYs opened in a row is found",
  async () => {
    for (let i = 0; i < IN_A_ROW; i++) {
      const pty = open();
      try {
        expect(pty.tty).toMatch(SLAVE_PATH);
        expect(statSync(pty.tty).isCharacterDevice()).toBe(true);
      } finally {
        await pty.close();
      }
    }
  },
  TEST_MS,
);

test("PTYs open together each get their own slave", async () => {
  const ptys = Array.from({ length: HELD }, () => open());
  try {
    expect(new Set(ptys.map((pty) => pty.tty)).size).toBe(HELD);
  } finally {
    await Promise.all(ptys.map((pty) => pty.close()));
  }
});

/**
 * A descriptor below the ones `spawnPty` takes is closed after it listed the open ones
 * (a pool thread closing a file, an earlier test's cleanup): the master reuses that
 * number and the slave the number the listing itself used for its directory. Both are
 * numbers the listing saw, yet the slave is new.
 */
test("the slave is found when a lower descriptor closes after the listing", () => {
  const hole = openSync("/dev/null", "r");
  let tty = "";
  let closed = false;
  const pty = spawnPty({
    command: (path) => {
      tty = path;
      return ["/bin/sleep", "30"];
    },
    // Read once the listing is taken and before the PTY opens.
    get cols() {
      if (!closed) {
        closed = true;
        closeSync(hole);
      }
      return 80;
    },
    rows: 24,
    onData: () => {},
    onExit: () => {},
  });
  try {
    expect(closed).toBe(true);
    expect(tty).toMatch(SLAVE_PATH);
  } finally {
    pty.kill();
  }
});
