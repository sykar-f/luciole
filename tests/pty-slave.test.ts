/**
 * The slave path `spawnPty` hands to a command function (src/vt/pty.ts): the one device
 * the PTY's program gets, found from the descriptor, whatever else the host is doing.
 */
import { test, expect } from "bun:test";
import { statSync } from "node:fs";
import { spawnPty, type Pty } from "../packages/luciole/src/vt/pty";

const PTYS = 200;
const SLAVE_PATH = /^\/dev\/(?:ttys\d+|pts\/\d+)$/;
const TEST_MS = 60_000;

test(
  "every slave of many PTYs opened in a row is found, each its own device",
  async () => {
    const ptys: Pty[] = [];
    const paths = new Set<string>();
    const exits: Promise<void>[] = [];
    for (let i = 0; i < PTYS; i++) {
      let seen = "";
      exits.push(
        new Promise<void>((done) => {
          ptys.push(
            spawnPty({
              command: (tty) => {
                seen = tty;
                return ["/bin/sleep", "30"];
              },
              cols: 80,
              rows: 24,
              onData: () => {},
              onExit: () => done(),
            }),
          );
        }),
      );
      expect(seen).toMatch(SLAVE_PATH);
      expect(statSync(seen).isCharacterDevice()).toBe(true);
      paths.add(seen);
    }
    expect(paths.size).toBe(PTYS);
    for (const pty of ptys) pty.kill();
    await Promise.all(exits);
  },
  TEST_MS,
);
