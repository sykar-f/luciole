/** Characterize the pinned npm renderer through real PTY mouse input. */
import { expect, test } from "bun:test";

const TIMEOUT_MS = 15_000;
test(
  "native OpenTUI omits a captured target until the next paint",
  async () => {
    const waiting = new Map<string, (message: string) => void>();
    const queued = new Map<string, string>();
    const receive = (name: string) => {
      const saved = queued.get(name);
      if (saved !== undefined) return Promise.resolve(saved);
      return new Promise<string>((resolve) => waiting.set(name, resolve));
    };
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
      import { createCliRenderer, BoxRenderable } from "@opentui/core";
      const r = await createCliRenderer({exitOnCtrlC:false, exitSignals:[]});
      const events=[];
      const box=new BoxRenderable(r,{width:10,height:5,onMouse:e=>events.push(e.type)});
      r.root.add(box);
      r.once('frame',()=>process.send('ready'));
      process.on('message', command=>{
        if(command==='paint') {
          r.once('frame',()=>process.send('paint:'+r.hitTest(2,2)));
          r.requestRender();
        }
      });
      box.onMouse=e=>{
        events.push(e.type);
        if(e.type==='drag') process.send('dragging');
        if(e.type==='up') queueMicrotask(()=>process.send('released:'+JSON.stringify(events)));
      };
      r.requestRender();
    `,
      ],
      {
        terminal: { cols: 30, rows: 10, data() {} },
        env: { ...process.env, TERM: "xterm-256color" },
        stdout: "ignore",
        stderr: "pipe",
        ipc(message) {
          if (typeof message !== "string") return;
          const name = message.split(":")[0] ?? message;
          const resolve = waiting.get(name);
          if (resolve) {
            waiting.delete(name);
            resolve(message);
          } else queued.set(name, message);
        },
      },
    );
    try {
      await receive("ready");
      child.terminal?.write("\x1b[<0;2;2M\x1b[<32;3;3M");
      // IPC is sent after the PTY input has been parsed; the captured paint proves it.
      await receive("dragging");
      child.send("paint");
      expect(await receive("paint")).toBe("paint:0");
      child.terminal?.write("\x1b[<0;3;3m\x1b[<0;3;3M");
      const events = await receive("released");
      console.log("native capture/release/press", events);
      expect(events).toContain('"drag-end"');
      expect(events.match(/"down"/g)?.length).toBe(1);
    } finally {
      child.kill();
      await child.exited;
      child.terminal?.close();
    }
  },
  TIMEOUT_MS,
);
