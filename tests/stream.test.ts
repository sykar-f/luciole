import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";
import { isAsyncIterable } from "../src/guards";
import { createHttpTransport } from "../src/transport";

const Job = z.tuple([
  z.literal("job"),
  z.custom<AsyncIterable<unknown>>(isAsyncIterable, "an async iterable"),
]);

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
    const [, stream] = Job.parse(await transport.render("/", {}, new AbortController().signal));
    expect(performance.now() - start).toBeLessThan(150);
    const received: unknown[] = [];
    for await (const line of stream) received.push(line);
    expect(received).toEqual(["line 1", "line 2", "line 3", "line 4"]);
    expect(performance.now() - start).toBeGreaterThanOrEqual(390);
  } finally {
    child.kill();
  }
});
