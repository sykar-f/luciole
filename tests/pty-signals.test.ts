/** Direct programs must get terminal signals from the kernel, without a shell. */
import { expect, test } from "bun:test";
import { spawnPty } from "../packages/core/src/vt/pty";
import { createWindowSession } from "../packages/desktop/src/host/session";
import { until } from "./helpers";

const program = `
process.on('SIGWINCH', () => setTimeout(() => console.log('SIGWINCH ' + process.stdout.columns + 'x' + process.stdout.rows), 0));
process.on('SIGINT', () => console.log('SIGINT'));
console.log('READY ' + process.stdout.columns + 'x' + process.stdout.rows);
setInterval(() => {}, 1000);
`;

test("a direct Bun program gets SIGWINCH and the new PTY size", async () => {
  let output = "";
  let done!: () => void;
  const exited = new Promise<void>((resolve) => {
    done = resolve;
  });
  const pty = spawnPty({
    command: [process.execPath, "-e", program],
    cols: 80,
    rows: 24,
    onData: (bytes) => {
      output += new TextDecoder().decode(bytes);
    },
    onExit: done,
  });
  try {
    await until(() => output.includes("READY 80x24"));
    pty.resize(120, 40);
    await until(() => output.includes("SIGWINCH 120x40"));
    expect(output).toContain("SIGWINCH 120x40");
  } finally {
    pty.kill();
    await exited;
  }
});

test.skipIf(process.platform !== "darwin")(
  "the direct program leads the foreground group and gets Ctrl+C",
  async () => {
    let output = "";
    let done!: () => void;
    const exited = new Promise<void>((resolve) => {
      done = resolve;
    });
    const foreground = `
const {dlopen} = require('bun:ffi');
const {symbols} = dlopen('libc.dylib', {tcgetpgrp:{args:['i32'],returns:'i32'}});
process.on('SIGINT', () => console.log('SIGINT'));
console.log('GROUP ' + process.pid + ' ' + symbols.tcgetpgrp(0));
setInterval(() => {}, 1000);
`;
    const pty = spawnPty({
      command: [process.execPath, "-e", foreground],
      cols: 80,
      rows: 24,
      onData: (bytes) => {
        output += new TextDecoder().decode(bytes);
      },
      onExit: done,
    });
    try {
      await until(() => output.includes("GROUP "));
      expect(output).toContain(`GROUP ${pty.pid} ${pty.pid}`);
      pty.write("\x03");
      await until(() => output.includes("SIGINT"));
    } finally {
      pty.kill();
      await exited;
    }
  },
);

test("a desktop session sends kernel SIGWINCH to a direct Bun program", async () => {
  let output = "";
  let done!: () => void;
  const exited = new Promise<void>((resolve) => {
    done = resolve;
  });
  const session = createWindowSession({
    command: [process.execPath, "-e", program],
    send: (text) => {
      output += text;
    },
    onExit: done,
  });
  session.open({ cols: 80, rows: 24 });
  try {
    await until(() => output.includes("READY 80x24"));
    session.resize({ cols: 120, rows: 40 });
    await until(() => output.includes("SIGWINCH 120x40"));
    expect(output).toContain("SIGWINCH 120x40");
  } finally {
    session.hangUp();
    await exited;
  }
});
