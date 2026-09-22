import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHttpTransport } from "../src/transport";

test("an async iterable keeps streaming after the root model, beyond the request timeout", async () => {
  const child = spawn(process.execPath, ["--conditions=react-server", "tests/stream-server.ts"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const { port } = JSON.parse((await lines.next()).value!);
    const transport = createHttpTransport({
      url: `http://127.0.0.1:${port}`,
      buildId: "build",
      timeoutMs: 150,
      callServer: () => Promise.reject(new Error("unused")),
    });
    const start = performance.now();
    const model = (await transport.render("/", {}, new AbortController().signal)) as unknown as {
      title: string;
      lines: AsyncIterable<string>;
    };
    expect(model.title).toBe("job");
    expect(performance.now() - start).toBeLessThan(150);
    const received: string[] = [];
    for await (const line of model.lines) received.push(line);
    expect(received).toEqual(["line 1", "line 2", "line 3", "line 4"]);
    expect(performance.now() - start).toBeGreaterThanOrEqual(390);
  } finally {
    child.kill();
  }
});
