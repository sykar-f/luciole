import "server-only";
import { z } from "zod";

// The last lines a harness wrote to stderr explain an early exit (a bad flag, no login).
const STDERR_KEPT = 2000;
// A request a harness never answers is reported, not awaited forever.
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Splits a byte stream into lines on LF only: a generic reader (readline) would also
 * split on U+2028 and U+2029, which JSON strings may hold unescaped.
 */
export async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let end = buffer.indexOf("\n");
    while (end >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, "");
      buffer = buffer.slice(end + 1);
      if (line) onLine(line);
      end = buffer.indexOf("\n");
    }
  }
  const rest = buffer + decoder.decode();
  if (rest.trim()) onLine(rest);
}

/** A parsed JSON line, or `undefined` for a line that is not JSON (a stray log). */
export function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

export type LineProcessOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  onLine: (line: string) => void;
};

/**
 * A child process speaking JSON lines on stdin/stdout. Its stderr is kept (the tail) to
 * explain an exit; `kill()` is synchronous, so a Server exiting never leaves it behind.
 */
export class LineProcess {
  private readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private stderr = "";
  /** Resolves when the process ended, with what explains it. */
  readonly exited: Promise<string>;

  constructor(argv: readonly string[], { cwd, env, onLine }: LineProcessOptions) {
    this.proc = Bun.spawn([...argv], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    void readLines(this.proc.stdout, onLine).catch(() => {});
    void readLines(this.proc.stderr, (line) => {
      this.stderr = `${this.stderr}${line}\n`.slice(-STDERR_KEPT);
    }).catch(() => {});
    const name = argv[0] ?? "harness";
    this.exited = this.proc.exited.then(
      (code) => this.stderr.trim().split("\n").at(-1) || `${name} exited with code ${code}`,
    );
  }

  get pid() {
    return this.proc.pid;
  }

  get running() {
    return this.proc.exitCode === null && this.proc.signalCode === null;
  }

  /** Writes one JSON line; false when the process is gone. */
  write(value: unknown) {
    if (!this.running) return false;
    try {
      void this.proc.stdin.write(`${JSON.stringify(value)}\n`);
      void this.proc.stdin.flush();
      return true;
    } catch {
      return false;
    }
  }

  kill() {
    if (this.running) this.proc.kill();
  }
}

const Id = z.union([z.string(), z.number()]);
const RpcError = z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() });
/** A JSON-RPC 2.0 message, with or without the `"jsonrpc"` field (Codex omits it). */
const RpcMessage = z.object({
  id: Id.optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: RpcError.optional(),
});

export class RpcFailure extends Error {
  readonly method: string;
  readonly code: number;
  constructor(method: string, code: number, message: string) {
    super(`${method}: ${message}`);
    this.method = method;
    this.code = code;
  }
}

export type RpcHandlers = {
  onNotification: (method: string, params: unknown) => void;
  /** A request from the harness: answer it with `peer.reply` or `peer.fail`. */
  onRequest: (id: string | number, method: string, params: unknown) => void;
};

/**
 * JSON-RPC over a line process: requests correlated by id, notifications and the
 * harness's own requests (approvals) handed over. Lines that are not JSON-RPC are
 * ignored; every value is checked (Zod) before it is used.
 */
export class RpcPeer {
  private readonly waiting = new Map<
    string,
    { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private next = 0;
  private readonly handlers: RpcHandlers;
  private readonly jsonrpc: boolean;
  readonly process: LineProcess;

  constructor(
    argv: readonly string[],
    options: Omit<LineProcessOptions, "onLine">,
    handlers: RpcHandlers,
    { jsonrpc = false }: { jsonrpc?: boolean } = {},
  ) {
    this.handlers = handlers;
    this.jsonrpc = jsonrpc;
    this.process = new LineProcess(argv, { ...options, onLine: (line) => this.dispatch(line) });
    void this.process.exited.then((reason) => {
      for (const [, waiter] of this.waiting) waiter.reject(new Error(reason));
      this.waiting.clear();
    });
  }

  private dispatch(line: string) {
    const parsed = RpcMessage.safeParse(parseLine(line));
    if (!parsed.success) return;
    const { id, method, params, result, error } = parsed.data;
    if (method !== undefined) {
      if (id !== undefined) this.handlers.onRequest(id, method, params);
      else this.handlers.onNotification(method, params);
      return;
    }
    if (id === undefined) return;
    const waiter = this.waiting.get(String(id));
    if (!waiter) return;
    this.waiting.delete(String(id));
    if (error) waiter.reject(new RpcFailure(waiter.method, error.code, error.message));
    else waiter.resolve(result);
  }

  private send(value: Record<string, unknown>) {
    return this.process.write(this.jsonrpc ? { jsonrpc: "2.0", ...value } : value);
  }

  /** Calls `method`; rejects with an `RpcFailure`, a timeout or the process's exit. */
  request(method: string, params?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(String(id));
        reject(new Error(`${method}: no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiting.set(String(id), {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      if (!this.send({ id, method, ...(params === undefined ? {} : { params }) })) {
        this.waiting.delete(String(id));
        clearTimeout(timer);
        reject(new Error(`${method}: the harness is not running`));
      }
    });
  }

  notify(method: string, params?: unknown) {
    this.send({ method, ...(params === undefined ? {} : { params }) });
  }

  reply(id: string | number, result: unknown) {
    this.send({ id, result });
  }

  fail(id: string | number, code: number, message: string) {
    this.send({ id, error: { code, message } });
  }

  kill() {
    this.process.kill();
  }
}
