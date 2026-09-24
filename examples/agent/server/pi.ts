import "server-only";
import { Event, Response } from "./protocol";
import type { z } from "zod";

type Response = z.infer<typeof Response>;
type Listener = (event: Event) => void;

// Commands answer quickly (`abort` waits for pi to settle); a silent pi is reported.
const COMMAND_TIMEOUT_MS = 30_000;
// The last lines pi wrote to stderr explain an early exit (bad model, missing login).
const STDERR_KEPT = 2_000;

/**
 * One `pi --mode rpc` process: JSON commands on stdin, JSON events on stdout, one per
 * line. Responses are matched to their command by `id`; everything else is an event.
 */
export class PiProcess {
  private readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private readonly waiting = new Map<string, (response: Response) => void>();
  private next = 0;
  private stderr = "";
  readonly exited: Promise<string>;

  constructor(argv: string[], cwd: string, onEvent: Listener) {
    this.proc = Bun.spawn(argv, { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    void this.read(this.proc.stdout, (line) => this.dispatch(line, onEvent));
    void this.read(this.proc.stderr, (line) => {
      this.stderr = `${this.stderr}${line}\n`.slice(-STDERR_KEPT);
    });
    this.exited = this.proc.exited.then((code) => {
      const failure = { type: "response" as const, command: "exit", success: false };
      for (const resolve of this.waiting.values())
        resolve({ ...failure, error: `pi exited (${code})` });
      this.waiting.clear();
      return this.stderr.trim().split("\n").at(-1) || `pi exited with code ${code}`;
    });
  }

  // pi frames records with LF only; a generic line reader would also split on U+2028.
  private async read(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
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
  }

  private dispatch(line: string, onEvent: Listener) {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return;
    }
    const event = Event.safeParse(json);
    if (!event.success) return;
    const data = event.data;
    if (data.type === "response" && data.id && this.waiting.has(data.id)) {
      this.waiting.get(data.id)?.(data);
      this.waiting.delete(data.id);
      return;
    }
    // Dialogs from extensions would block pi forever: this UI has none, it declines.
    if (data.type === "extension_ui_request")
      this.write({ type: "extension_ui_response", id: data.id, cancelled: true });
    onEvent(data);
  }

  private write(command: Record<string, unknown>) {
    void this.proc.stdin.write(`${JSON.stringify(command)}\n`);
    void this.proc.stdin.flush();
  }

  /** Sends a command and resolves with pi's response (`success: false` on failure). */
  send(command: Record<string, unknown>): Promise<Response> {
    const id = `c${++this.next}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve({
          type: "response",
          command: "timeout",
          success: false,
          error: "pi did not answer",
        });
      }, COMMAND_TIMEOUT_MS);
      this.waiting.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      try {
        this.write({ ...command, id });
      } catch {
        this.waiting.delete(id);
        clearTimeout(timer);
        resolve({ type: "response", command: "write", success: false, error: "pi is not running" });
      }
    });
  }

  kill() {
    this.proc.kill();
  }
}
