/**
 * A headless Chrome driven over the DevTools protocol, without a dependency: what the
 * web journeys and probes need of a browser (open a page, evaluate, type, capture): the
 * browser-side counterpart of scripts/pty/driver.ts.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod/mini";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const POLL_MS = 50;
const START_TIMEOUT_MS = 10_000;
const WAIT_TIMEOUT_MS = 15_000;

const Target = z.object({ type: z.string(), webSocketDebuggerUrl: z.string() });
const Reply = z.object({
  id: z.number(),
  result: z.optional(z.unknown()),
  error: z.optional(z.object({ message: z.string() })),
});
const Event = z.object({ method: z.string(), params: z.unknown() });
const Evaluated = z.object({
  result: z.object({ value: z.optional(z.unknown()) }),
  exceptionDetails: z.optional(z.object({ text: z.string() })),
});
const Screenshot = z.object({ data: z.string() });
const Point = z.object({ x: z.number(), y: z.number() });
const Thrown = z.object({
  exceptionDetails: z.object({
    text: z.string(),
    exception: z.optional(z.object({ description: z.optional(z.string()) })),
  }),
});
const Logged = z.object({
  type: z.string(),
  args: z.array(z.object({ value: z.optional(z.unknown()), description: z.optional(z.string()) })),
});

const KEYS = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Escape: { code: "Escape", keyCode: 27, text: "" },
  Tab: { code: "Tab", keyCode: 9, text: "\t" },
} as const;

const Context = z.object({
  context: z.object({ id: z.number(), origin: z.string() }),
});

export class Browser implements AsyncDisposable {
  readonly logs: string[] = [];
  /** The execution contexts the page made, by id: a frame of another origin has its own. */
  private readonly contexts = new Map<number, string>();
  private sequence = 0;
  private readonly pending = new Map<number, (reply: z.infer<typeof Reply>) => void>();
  private readonly process: Bun.Subprocess;
  private readonly socket: WebSocket;

  private constructor(process: Bun.Subprocess, socket: WebSocket) {
    this.process = process;
    this.socket = socket;
    socket.addEventListener("message", ({ data }) => this.receive(String(data)));
  }

  static async start() {
    const profile = mkdtempSync(join(tmpdir(), "luciole-cdp-"));
    const chrome = Bun.spawn(
      [
        CHROME,
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    // A BunFile made before the file exists keeps answering that it does not.
    const portFile = join(profile, "DevToolsActivePort");
    const deadline = performance.now() + START_TIMEOUT_MS;
    while (!existsSync(portFile)) {
      if (performance.now() > deadline) throw new Error(`${CHROME} did not start`);
      await Bun.sleep(POLL_MS);
    }
    const [port] = (await Bun.file(portFile).text()).split("\n");
    const targets = z
      .array(Target)
      .parse(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("Chrome opened no page");
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const browser = new Browser(chrome, socket);
    await browser.send("Runtime.enable");
    await browser.send("Page.enable");
    return browser;
  }

  private receive(text: string) {
    const json: unknown = JSON.parse(text);
    const reply = Reply.safeParse(json);
    if (reply.success) {
      this.pending.get(reply.data.id)?.(reply.data);
      this.pending.delete(reply.data.id);
      return;
    }
    const event = Event.safeParse(json);
    if (!event.success) return;
    const context = Context.safeParse(event.data.params);
    if (event.data.method === "Runtime.executionContextCreated" && context.success)
      this.contexts.set(context.data.context.id, context.data.context.origin);
    if (event.data.method === "Runtime.executionContextsCleared") this.contexts.clear();
    const thrown = Thrown.safeParse(event.data.params);
    if (event.data.method === "Runtime.exceptionThrown" && thrown.success)
      this.logs.push(
        thrown.data.exceptionDetails.exception?.description ?? thrown.data.exceptionDetails.text,
      );
    const logged = Logged.safeParse(event.data.params);
    if (event.data.method === "Runtime.consoleAPICalled" && logged.success)
      this.logs.push(
        `console.${logged.data.type}: ${logged.data.args.map((a) => a.description ?? JSON.stringify(a.value)).join(" ")}`,
      );
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.sequence;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, (reply) =>
        reply.error
          ? reject(new Error(`${method}: ${reply.error.message}`))
          : resolve(reply.result),
      );
    });
  }

  async open(url: string) {
    await this.send("Page.navigate", { url });
  }

  async evaluate(expression: string): Promise<unknown> {
    const evaluated = Evaluated.parse(
      await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }),
    );
    if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text);
    return evaluated.result.value;
  }

  /**
   * `expression` in the latest frame of `origin`: what a page of another origin cannot
   * read through its script, the protocol reads in the frame's own context.
   */
  async evaluateIn(origin: string, expression: string): Promise<unknown> {
    const contextId = [...this.contexts].findLast(([, at]) => at === origin)?.[0];
    if (contextId === undefined) throw new Error(`no frame of ${origin} in the page`);
    const evaluated = Evaluated.parse(
      await this.send("Runtime.evaluate", { expression, contextId, returnByValue: true }),
    );
    if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text);
    return evaluated.result.value;
  }

  /** Waits until `expression` evaluates to a truthy value, and returns it. */
  async waitFor(expression: string, what: string, timeout = WAIT_TIMEOUT_MS): Promise<unknown> {
    const deadline = performance.now() + timeout;
    for (;;) {
      const value = await this.evaluate(expression).catch(() => undefined);
      if (value) return value;
      if (performance.now() > deadline)
        throw new Error(`the page never showed ${what}\n--- page logs\n${this.logs.join("\n")}`);
      await Bun.sleep(POLL_MS);
    }
  }

  /** Text as typed by a keyboard with an input method: one insertion. */
  async insertText(text: string) {
    await this.send("Input.insertText", { text });
  }

  async press(key: keyof typeof KEYS) {
    const { code, keyCode, text } = KEYS[key];
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, text });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  /** A left click at `expression`, a point `{ x, y }` in the page's coordinates. */
  async clickAt(expression: string) {
    const point = Point.parse(await this.evaluate(expression));
    for (const type of ["mousePressed", "mouseReleased"])
      await this.send("Input.dispatchMouseEvent", {
        type,
        ...point,
        button: "left",
        clickCount: 1,
      });
  }

  /** A left click in the middle of the first element `selector` matches. */
  async click(selector: string) {
    await this.clickAt(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
  }

  async screenshot(file: string) {
    const { data } = Screenshot.parse(await this.send("Page.captureScreenshot", { format: "png" }));
    await Bun.write(file, Buffer.from(data, "base64"));
  }

  async [Symbol.asyncDispose]() {
    this.socket.close();
    this.process.kill();
    await this.process.exited;
  }
}
