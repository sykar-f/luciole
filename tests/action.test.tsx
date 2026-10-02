/** @jsxImportSource @opentui/react */
import { test, expect } from "bun:test";
import { act, useState, useEffect, type ReactNode } from "react";
import { InputRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";
import { decode, encodeReply, registerModules } from "../packages/core/src/flight/client";
import { isReactNode } from "../packages/core/src/transport";
import { destroy, type TestUI } from "./helpers";
// The first line tests/action-server.ts prints.
const Started = z.object({ port: z.number().int(), pid: z.number().int() });
test("milestone 1: Flight action via HTTP, local typing, refresh without remount", async () => {
  const child = spawn(process.execPath, ["--conditions=react-server", "tests/action-server.ts"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let rendered: TestUI | undefined;
  try {
    const first = await lines.next();
    if (first.done) throw new Error("The test Server printed nothing");
    const { port, pid } = Started.parse(JSON.parse(first.value));
    expect(pid).not.toBe(process.pid);
    let field: InputRenderable | undefined,
      refresh: ((tree: ReactNode) => void) | undefined,
      done: Promise<void> | undefined,
      result: unknown;
    const body = (response: Response) => {
      if (!response.body) throw new Error("The test Server answered without a body");
      return response.body;
    };
    async function callServer(id: string, args: unknown[]) {
      expect(id).toBe("save#default");
      const response = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        body: await encodeReply(args),
      });
      return await decode(body(response), callServer);
    }
    const load = async () => {
      const tree = await decode(body(await fetch(`http://127.0.0.1:${port}`)), callServer);
      if (!isReactNode(tree)) throw new Error("The test Server rendered no React tree");
      return tree;
    };
    // Receives a Server Function reference from the Flight tree.
    function Editor({ save }: { save: (value: string) => Promise<unknown> }) {
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
              refresh?.(await load());
            })();
          }}
        />
      );
    }
    registerModules("", () => ({ Editor }));
    const initial = await load();
    function Shell() {
      const [tree, setTree] = useState<ReactNode>(initial);
      useEffect(() => {
        refresh = setTree;
      }, [setTree]);
      return tree;
    }
    const ui = await testRender(<Shell />, { width: 40, height: 5 });
    rendered = ui;
    await act(async () => {
      await ui.mockInput.typeText("abc");
    });
    await act(async () => {
      ui.mockInput.pressEnter();
    });
    const instance = field;
    await act(async () => {
      await ui.mockInput.typeText("d");
    });
    expect(field?.value).toBe("abcd");
    expect(result).toBeUndefined();
    expect(done).toBeDefined();
    await act(async () => {
      await done;
    });
    await ui.renderOnce();
    expect(result).toEqual({ value: "abc", pid });
    expect(field).toBe(instance);
    expect(field?.value).toBe("abcd");
    expect(ui.captureCharFrame()).toContain("Saved:abc");
  } finally {
    await destroy(rendered);
    child.kill();
  }
});
