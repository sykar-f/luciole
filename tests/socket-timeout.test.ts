import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { connect, socketDirectory } from "../packages/luciole/src/connect";
import { isAsyncIterable } from "../packages/luciole/src/guards";
import { createHttpTransport } from "../packages/luciole/src/transport";

// Bun applies its default idle timeout (10 s) on a Unix socket, where serve() cannot set
// its own: a slow page, a slow Server Function and a stream quiet for 12 s must still
// complete, as they do over TCP.
test("a socket Server answers after more than Bun's idle timeout", async () => {
  const socket = join(socketDirectory("luciole-slow-"), "s");
  const server = spawn(process.execPath, ["--conditions=react-server", "tests/slow-server.ts"], {
    env: { ...process.env, LUCIOLE_SOCKET: socket },
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("exit", () => reject(new Error("Server exited")));
      createInterface({ input: server.stdout }).once("line", () => resolve());
    });
    const transport = createHttpTransport({
      ...(await connect(`unix:${socket}`)),
      buildId: "build-1",
      timeoutMs: 60_000,
      callServer: () => Promise.reject(new Error("unused")),
    });
    const [page, result, stream] = await Promise.all([
      transport.render("/", {}, new AbortController().signal),
      transport.call("a.ts#slow", []),
      (async () => {
        const values: unknown[] = [];
        const iterable = await transport.call("a.ts#quiet", []);
        if (!isAsyncIterable(iterable)) throw new Error("Expected a stream");
        for await (const value of iterable) values.push(value);
        return values;
      })(),
    ]);
    expect(JSON.stringify(page)).toContain("slow page");
    expect(result).toBe("slow result");
    expect(stream).toEqual(["first", "second"]);
  } finally {
    server.kill();
    await rm(dirname(socket), { recursive: true, force: true });
  }
}, 60_000);
