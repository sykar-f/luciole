/** Fail before starting the launcher when the requested command cannot be found. */
import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnPty } from "../packages/core/src/vt/pty";
import { until } from "./helpers";

test.skipIf(process.platform !== "darwin")(
  "a missing command throws synchronously and closes its PTY",
  () => {
    let slave = "";
    expect(() =>
      spawnPty({
        command: (path) => {
          slave = path;
          return ["luciole-no-such-command"];
        },
        cols: 80,
        rows: 24,
        onData: () => {},
        onExit: () => {},
      }),
    ).toThrow("Terminal command not found: luciole-no-such-command");
    expect(slave).toMatch(/^\/dev\/ttys\d+$/);
    const open = readdirSync("/dev/fd").flatMap((fd) => {
      try {
        return [realpathSync(`/dev/fd/${fd}`)];
      } catch {
        return [];
      }
    });
    expect(open).not.toContain(slave);
  },
);

test.skipIf(process.platform !== "darwin")(
  "command lookup uses the child's cwd and replacement PATH",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "pty path "));
    mkdirSync(join(directory, "bin"));
    const executable = join(directory, "bin/probe");
    writeFileSync(executable, '#!/bin/sh\nprintf \'FOUND %s %s\' "$PWD" "$PTY_TEST"\n');
    chmodSync(executable, 0o755);
    let output = "";
    let exit: number | null | undefined;
    const pty = spawnPty({
      command: ["probe"],
      cwd: directory,
      environment: "replace",
      env: { PATH: "bin", PTY_TEST: "child-env" },
      cols: 80,
      rows: 24,
      onData: (b) => {
        output += new TextDecoder().decode(b);
      },
      onExit: (c) => {
        exit = c;
      },
    });
    try {
      await until(() => exit !== undefined);
      expect(exit).toBe(0);
      expect(output).toContain(`FOUND ${realpathSync(directory)} child-env`);
      expect(() =>
        spawnPty({
          command: ["bun"],
          environment: "replace",
          env: { PATH: "" },
          cwd: directory,
          cols: 80,
          rows: 24,
          onData: () => {},
          onExit: () => {},
        }),
      ).toThrow("Terminal command not found: bun");
    } finally {
      pty.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "darwin")(
  "an exec failure after lookup goes to the PTY and exits 127",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "pty-exec-"));
    const executable = join(directory, "probe");
    writeFileSync(executable, "#!/luciole-no-such-interpreter\n");
    chmodSync(executable, 0o755);
    let output = "";
    let exit: number | null | undefined;
    const pty = spawnPty({
      command: [executable],
      cols: 80,
      rows: 24,
      onData: (b) => {
        output += new TextDecoder().decode(b);
      },
      onExit: (c) => {
        exit = c;
      },
    });
    try {
      await until(() => exit !== undefined);
      expect(exit).toBe(127);
      expect(output).toContain(executable);
      expect(output).toContain("No such file");
    } finally {
      pty.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
