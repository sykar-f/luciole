/** @jsxImportSource @opentui/react */
import { test, expect } from "bun:test";
import { act, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { decode, encodeReply, installResolver } from "../src/flight/client";
test("milestone 1: Flight action via HTTP, local typing, refresh without remount", async () => {
  const child = spawn(
    process.execPath,
    ["--conditions=react-server", "tests/action-server.ts"],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  let ui: any;
  try {
    const { port, pid } = JSON.parse((await lines.next()).value!);
    expect(pid).not.toBe(process.pid);
    let field: any, refresh: any, done: Promise<void>, result: any;
    async function callServer(id: string, args: unknown[]) {
      expect(id).toBe("save#default");
      const response = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        body: await encodeReply(args),
      });
      return await decode(response.body!, callServer);
    }
    const load = async () =>
      await decode((await fetch(`http://127.0.0.1:${port}`)).body!, callServer);
    function Editor({ save }: any) {
      const [value, setValue] = useState("");
      return (
        <input
          ref={(r) => {
            if (r) field = r;
          }}
          value={value}
          focused
          onInput={setValue}
          onSubmit={() => {
            done = (async () => {
              result = await save(value);
              refresh(await load());
            })();
          }}
        />
      );
    }
    installResolver(() => ({ Editor }));
    const initial = await load();
    function Shell() {
      const [tree, setTree] = useState(initial);
      refresh = setTree;
      return tree;
    }
    ui = await testRender(<Shell />, { width: 40, height: 5 });
    await act(async () => {
      await ui.mockInput.typeText("abc");
    });
    await act(async () => {
      await ui.mockInput.pressEnter();
    });
    const instance = field;
    await act(async () => {
      await ui.mockInput.typeText("d");
    });
    expect(field.value).toBe("abcd");
    expect(result).toBeUndefined();
    await act(async () => {
      await done!;
    });
    await ui.renderOnce();
    expect(result).toEqual({ value: "abc", pid });
    expect(field).toBe(instance);
    expect(field.value).toBe("abcd");
    expect(ui.captureCharFrame()).toContain("Saved:abc");
  } finally {
    if (ui) await act(async () => ui.renderer.destroy());
    child.kill();
  }
});
