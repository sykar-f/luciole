/** @jsxImportSource @opentui/react */
import { testRender } from "@opentui/react/test-utils";
import { act, useState, useEffect } from "react";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const server = spawn(process.execPath, ["server.ts"], { stdio: ["pipe", "pipe", "inherit"] });
const responses = createInterface({ input: server.stdout })[Symbol.asyncIterator]();
async function next() {
  return JSON.parse((await responses.next()).value!);
}
const ready = await next();
assert.notEqual(ready.pid, process.pid);
const results: Record<string, unknown> = {
  versions: { core: "0.5.12", react: "19.3.0" },
  separatePids: true,
};
try {
  for (const guarded of [false, true]) {
    let field: any;
    let revision = 0;
    let setDraft!: (value: string) => void;
    let redraw!: () => void;
    function App() {
      const [value, setValue] = useState("");
      const [count, setCount] = useState(0);
      useEffect(() => {
        setDraft = setValue;
        redraw = () => setCount((c) => c + 1);
      }, [setValue, setCount]);
      return (
        <box>
          <input
            id="draft"
            ref={(r) => {
              if (r) field = r;
            }}
            focused
            value={value}
            onInput={(text) => {
              revision++;
              setValue(text);
            }}
          />
          <text>Refresh {count}</text>
        </box>
      );
    }
    const ui = await testRender(<App />, { width: 40, height: 5 });
    try {
      await act(async () => {
        await ui.mockInput.typeText("abc");
      });
      assert.equal(field.value, "abc");
      const instance = field;
      const sentRevision = revision;
      server.stdin.write(JSON.stringify({ id: guarded ? 2 : 1, value: field.value }) + "\n");
      assert.ok((await next()).started);
      const begin = performance.now();
      await act(async () => {
        await ui.mockInput.typeText("d");
        redraw();
      });
      await ui.renderOnce();
      const localMs = performance.now() - begin;
      assert.equal(field.value, "abcd");
      assert.equal(field, instance);
      assert.ok(ui.captureCharFrame().includes("abcd"));
      const response = await next();
      assert.notEqual(response.pid, process.pid);
      if (!guarded || revision === sentRevision) {
        await act(async () => {
          setDraft(response.value);
        });
      }
      assert.equal(field.value, guarded ? "abcd" : "ABC");
      results[guarded ? "revisionGuard" : "naiveRpc"] = {
        localEditMs: localMs,
        draftBeforeReply: "abcd",
        draftAfterReply: field.value,
        sameInstanceAfterRender: field === instance,
      };
      if (guarded) {
        server.kill();
        await act(async () => {
          await ui.mockInput.typeText("e");
        });
        assert.equal(field.value, "abcde");
        results.editAfterDisconnect = field.value;
        let fired = false;
        const start = performance.now();
        const timer = new Promise<number>((resolve) =>
          setTimeout(() => {
            fired = true;
            resolve(performance.now() - start);
          }, 0),
        );
        while (performance.now() - start < 150) {}
        assert.equal(fired, false);
        results.clientSyncCallbackTimerDelayMs = await timer;
      }
    } finally {
      await act(async () => {
        ui.renderer.destroy();
      });
    }
  }
} finally {
  server.kill();
}
await Bun.write("results.json", JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results, null, 2));
