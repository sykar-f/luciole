import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";
import { isAsyncIterable } from "../packages/core/src/guards";
import { createHttpTransport } from "../packages/core/src/transport";

const Job = z.tuple([
  z.literal("job"),
  z.custom<AsyncIterable<unknown>>(isAsyncIterable, "an async iterable"),
]);

/**
 * The request deadline, held by the test instead of a clock: the transport's deadline timer
 * (the only one set for this delay) is never started, its callback waits here, and the test
 * fires it itself once the root model has arrived. The deadline passes when the test says,
 * however slow the host is.
 */
const DEADLINE_MS = 3_600_000;

test("an async iterable keeps streaming after the root model, beyond the request timeout", async () => {
  const child = spawn(process.execPath, ["--conditions=react-server", "tests/stream-server.ts"], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const { setTimeout: start, clearTimeout: stop } = globalThis;
  const watch = (name: "setTimeout" | "clearTimeout", value: unknown) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const deadlineTimer = {};
  let deadline: (() => void) | undefined;
  let captured = false;
  try {
    watch(
      "setTimeout",
      (handler: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
        if (ms !== DEADLINE_MS) return start(handler, ms, ...rest);
        deadline = handler;
        captured = true;
        return deadlineTimer;
      },
    );
    watch("clearTimeout", (timer?: Parameters<typeof clearTimeout>[0]) => {
      if (timer === deadlineTimer) deadline = undefined;
      else stop(timer);
    });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const { value: line } = await lines.next();
    const { port } = z.object({ port: z.number() }).parse(JSON.parse(z.string().parse(line)));
    const transport = createHttpTransport({
      url: `http://127.0.0.1:${port}`,
      buildId: "build",
      timeoutMs: DEADLINE_MS,
      callServer: () => Promise.reject(new Error("unused")),
    });
    // The root model arrives; the iterable behind it is held by the Server until released.
    const [, stream] = Job.parse(await transport.render("/", {}, new AbortController().signal));
    // The transport armed its deadline through the timer the test holds: without it, firing
    // below would exercise nothing.
    expect(captured).toBe(true);
    // The deadline passes now, if the transport left it armed: a transport whose deadline
    // cuts the stream fails below, one that disarmed it with the root does not notice.
    deadline?.();
    child.stdin.write("go\n");
    const received: unknown[] = [];
    for await (const line of stream) received.push(line);
    expect(received).toEqual(["line 1", "line 2", "line 3", "line 4"]);
  } finally {
    watch("setTimeout", start);
    watch("clearTimeout", stop);
    child.kill();
  }
});
