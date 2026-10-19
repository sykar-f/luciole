/** The native launcher must exec before Seatbelt and keep Bun's IPC descriptors. */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Capabilities } from "../packages/core/src/capabilities";
import { openSandbox } from "../packages/core/src/sandbox/spawn";
import { sandboxRuntime } from "../packages/core/src/sandbox/runtime";
import { until } from "./helpers";

test.skipIf(process.platform !== "darwin")(
  "sandbox PTY keeps its exact slave and IPC in both directions",
  async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "pty-sandbox-")));
    const app = join(directory, "app");
    mkdirSync(app);
    writeFileSync(join(app, "manifest.json"), "{}");
    const child = join(directory, "child.ts");
    writeFileSync(
      child,
      `
import {dlopen} from 'bun:ffi';
const {symbols} = dlopen('libc.dylib', {ttyname:{args:['i32'],returns:'cstring'}});
process.on('SIGWINCH', () => setTimeout(() => console.log('SIGWINCH '+process.stdout.columns+'x'+process.stdout.rows),0));
process.on('message', message => {
  console.log('IPC '+JSON.stringify(message));
  if (message.hello === 'host') process.send({kind:'request',id:7,request:{type:'notify',title:'pty-probe'}});
});
console.log('SLAVE '+symbols.ttyname(0));
setInterval(() => {},1000);
`,
    );
    const runtime = await sandboxRuntime();
    let profile = "",
      output = "";
    let done!: () => void;
    const exited = new Promise<void>((resolve) => {
      done = resolve;
    });
    const performed: unknown[] = [];
    const sandbox = await openSandbox(
      {
        origin: "http://127.0.0.1:9",
        url: "http://127.0.0.1:9",
        app,
        fingerprint: "pty-test",
        sessions: "pty-test",
        granted: Capabilities.parse({ notify: true }),
        runtime: { ...runtime, code: [...runtime.code, directory] },
        child,
        mechanism: { kind: "seatbelt" },
      },
      {
        env: { XDG_STATE_HOME: directory },
        onProfile: (p) => {
          profile = p;
        },
        perform: async (request) => {
          performed.push(request);
          return null;
        },
      },
    );
    try {
      const pty = sandbox.spawn({
        cols: 80,
        rows: 24,
        onData: (b) => {
          output += new TextDecoder().decode(b);
        },
        onExit: done,
      });
      await until(
        () => output.includes("SLAVE "),
        5000,
        () => output,
      );
      const slave = /SLAVE (\/dev\/ttys\d+)/.exec(output)?.[1];
      expect(slave).toBeDefined();
      expect(profile).toContain(`(allow file-ioctl (literal "${slave}"))`);
      expect(profile).not.toContain('"/dev/ttys*"');
      pty.resize(120, 40);
      await until(
        () => output.includes("SIGWINCH 120x40"),
        5000,
        () => output,
      );
      pty.send({ hello: "host" });
      await until(
        () => output.includes('IPC {"hello":"host"}'),
        5000,
        () => output,
      );
      await until(
        () => output.includes('IPC {"kind":"reply","id":7,"ok":true,"value":null}'),
        5000,
        () => output,
      );
      expect(performed).toEqual([{ type: "notify", title: "pty-probe" }]);
    } finally {
      await sandbox.close();
      await exited;
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
