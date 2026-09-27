import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { Request, Response } from "../packages/harness/src/model";
import { opencodeAnthropicOAuth, USE_CLAUDE } from "../packages/harness/src/anthropic-guard";
import {
  MODE_RULES,
  OpencodeHarness,
  type OpencodeDeps,
  type OpencodeServer,
} from "../packages/harness/src/adapters/opencode";
import type { HarnessEvent } from "../packages/harness/src/adapters/types";
import { messageOf } from "../packages/airtty/src/guards";
import { rejectionOf } from "./helpers";

// Exchanges recorded on the real opencode 1.18.31 by scripts/coder/record-opencode.ts,
// replayed in step with the adapter: its events wait for the requests that caused them.
const FIXTURES = resolve("tests/fixtures/coder/opencode");
const Entry = z.union([
  z.object({
    dir: z.literal("out"),
    request: z.object({ method: z.string(), path: z.string(), body: z.unknown().optional() }),
  }),
  z.object({
    dir: z.literal("in"),
    response: z.object({
      method: z.string(),
      path: z.string(),
      status: z.number(),
      body: z.unknown(),
    }),
  }),
  z.object({ dir: z.literal("event"), event: z.unknown() }),
]);
type Entry = z.infer<typeof Entry>;
const fixture = async (name: string): Promise<Entry[]> =>
  (await readFile(join(FIXTURES, `${name}.jsonl`), "utf8"))
    .trim()
    .split("\n")
    .map((line) => Entry.parse(JSON.parse(line)));

type Call = { method: string; path: string; body?: unknown };
type Waiting = Call & { resolve: (body: unknown) => void };
// Routes the recordings did not need, answered as opencode 1.18.31 would.
const MODEL = { id: "mimo-v2.6-flash-free", name: "MiMo V2.6 Flash Free" };
const ANSWERS: Record<string, unknown> = {
  "GET /provider": {
    all: [
      {
        id: "opencode",
        name: "OpenCode Zen",
        models: { [MODEL.id]: { ...MODEL, limit: { context: 262_144 }, variants: { high: {} } } },
      },
      { id: "anthropic", name: "Anthropic", models: { "claude-x": { id: "claude-x" } } },
      { id: "google", name: "Google", models: { "gemini-x": { id: "gemini-x" } } },
    ],
    default: { opencode: MODEL.id },
    connected: ["opencode", "anthropic"],
  },
  "GET /config": { model: `opencode/${MODEL.id}` },
  "GET /command": [{ name: "review", description: "Review changes" }],
};

class Replay implements OpencodeServer {
  readonly calls: Call[] = [];
  private readonly lines: readonly Entry[];
  private readonly answers: Record<string, unknown>;
  private readonly queued: Waiting[] = [];
  private readonly sent: Waiting[] = [];
  private listener: ((event: unknown) => void) | undefined;
  private cursor = 0;
  private stop: (reason: string) => void = () => {};
  readonly exited = new Promise<string>((resolve) => (this.stop = resolve));
  constructor(lines: readonly Entry[], answers: Record<string, unknown>) {
    this.lines = lines;
    this.answers = answers;
  }
  /** Whether the recording still has this request to make. */
  private ahead({ method, path }: Call) {
    return this.lines
      .slice(this.cursor)
      .some((l) => l.dir === "out" && l.request.method === method && l.request.path === path);
  }
  /** A request the adapter made again, or that the recording did not need. */
  private answer({ method, path }: Call) {
    const key = `${method} ${path}`;
    if (key in this.answers) return this.answers[key];
    const recorded = this.lines.findLast(
      (l) => l.dir === "in" && l.response.method === method && l.response.path === path,
    );
    return recorded?.dir === "in" ? recorded.response.body : null;
  }
  private pump() {
    while (this.cursor < this.lines.length) {
      const line = this.lines[this.cursor];
      if (!line) return;
      if (line.dir === "event") {
        if (!this.listener) return;
        this.cursor++;
        this.listener(line.event);
        continue;
      }
      const { method, path } = line.dir === "out" ? line.request : line.response;
      const match = (w: Waiting) => w.method === method && w.path === path;
      if (line.dir === "out") {
        const at = this.queued.findIndex(match);
        if (at < 0) return;
        this.sent.push(...this.queued.splice(at, 1));
      } else {
        const at = this.sent.findIndex(match);
        if (at >= 0) this.sent.splice(at, 1)[0]?.resolve(line.response.body);
      }
      this.cursor++;
    }
  }
  call(method: string, path: string, body?: unknown) {
    const call = { method, path, ...(body === undefined ? {} : { body }) };
    this.calls.push(call);
    if (!this.ahead(call) || `${method} ${path}` in this.answers)
      return Promise.resolve(this.answer(call));
    return new Promise<unknown>((resolve) => {
      this.queued.push({ ...call, resolve });
      queueMicrotask(() => this.pump());
    });
  }
  async events(onEvent: (event: unknown) => void) {
    this.listener = onEvent;
    queueMicrotask(() => this.pump());
    await this.exited;
  }
  kill() {
    this.stop("killed");
  }
}

async function replay(
  name: string,
  answer: (request: Request) => Response = () => ({ kind: "approval", decision: "once" }),
  options: {
    answers?: Record<string, unknown>;
    model?: string;
    blocked?: readonly string[];
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const events: HarnessEvent[] = [];
  const server = new Replay(await fixture(name), { ...ANSWERS, ...options.answers });
  const served: { cwd: string; env: NodeJS.ProcessEnv }[] = [];
  const deps: OpencodeDeps = {
    opencode: () => "/usr/local/bin/opencode",
    serve: async (_binary, served_) => {
      served.push(served_);
      return server;
    },
    anthropicOAuth: options.blocked
      ? async () => options.blocked ?? []
      : (env, get) => opencodeAnthropicOAuth({ PATH: env.PATH, HOME: "/nonexistent" }, get),
  };
  const harness: OpencodeHarness = new OpencodeHarness(
    {
      emit: (event) => {
        events.push(event);
        if (event.type === "request.opened")
          queueMicrotask(() => void harness.respond(event.request, answer(event.request)));
      },
      env: options.env ?? { PATH: "/usr/bin:/bin" },
    },
    deps,
  );
  const start = () =>
    harness.start({
      cwd: "/project",
      mode: "ask",
      ...(options.model ? { model: options.model } : {}),
    });
  const settled = async () => {
    for (let i = 0; i < 400 && !events.some((e) => e.type === "turn.completed"); i++)
      await Bun.sleep(5);
    await Bun.sleep(20);
  };
  const sent = (path: RegExp) => server.calls.filter((c) => path.test(c.path));
  return { harness, events, server, served, start, settled, sent };
}
const completed = (events: readonly HarnessEvent[]) =>
  events.flatMap((e) => (e.type === "item.completed" ? [e.item] : []));

test("say ok: a session with coder's rules, the prompt, the reply, usage and a settled turn", async () => {
  const { harness, events, start, settled, sent } = await replay("say-ok");
  await start();
  expect(sent(/^\/session$/)[0]?.body).toEqual({ permission: MODE_RULES.ask });
  await harness.send({ text: "Reply with exactly: ok" });
  await settled();
  expect(sent(/prompt_async$/)[0]?.body).toEqual({
    model: { providerID: "opencode", modelID: MODEL.id },
    agent: "build",
    parts: [{ type: "text", text: "Reply with exactly: ok" }],
  });
  const items = completed(events);
  expect(items.find((i) => i.kind === "message")).toMatchObject({ text: "ok", streaming: false });
  expect(items.find((i) => i.kind === "reasoning")).toBeDefined();
  // The prompt itself is coder's to show: opencode's copy of it is not repeated.
  expect(items.some((i) => i.kind === "message" && i.text.includes("Reply with"))).toBe(false);
  expect(events.some((e) => e.type === "item.delta" && e.delta === "ok")).toBe(true);
  expect(events.find((e) => e.type === "turn.completed")).toEqual({
    type: "turn.completed",
    status: "completed",
  });
  const usage = events.flatMap((e) => (e.type === "usage.updated" ? [e.usage] : []));
  expect(usage.at(-1)).toMatchObject({ context: { window: 262_144 }, costUsd: 0 });
  expect(events.some((e) => e.type === "info.updated" && e.info.version === "1.18.31")).toBe(true);
  await harness.close();
});

test("the server: the project's directory, no Anthropic OAuth token in its environment", async () => {
  const { harness, served, start } = await replay("say-ok", undefined, {
    env: {
      PATH: "/usr/bin",
      ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat-x",
      ANTHROPIC_API_KEY: "sk-ant-oat-y",
      OPENAI_API_KEY: "sk-z",
    },
  });
  await start();
  expect(served[0]).toEqual({ cwd: "/project", env: { PATH: "/usr/bin", OPENAI_API_KEY: "sk-z" } });
  await harness.close();
});

test("bash: opencode's permission is an approval; allowed once, the command runs", async () => {
  const requests: Request[] = [];
  const { harness, events, settled, start, sent } = await replay("bash", (request) => {
    requests.push(request);
    return { kind: "approval", decision: "once" };
  });
  await start();
  await harness.send({ text: "echo" });
  await settled();
  expect(requests[0]).toMatchObject({
    kind: "approval",
    title: "Run a command",
    command: "echo coder-fixture",
    decisions: ["once", "session", "deny"],
  });
  expect(sent(/^\/permission\/.+\/reply$/)[0]?.body).toEqual({ reply: "once" });
  const command = completed(events).find((i) => i.kind === "command");
  expect(command).toMatchObject({ command: "echo coder-fixture", status: "done" });
  expect(command?.kind === "command" && command.output).toContain("coder-fixture");
  await harness.close();
});

test("edit: the approval shows opencode's diff; for the session is opencode's always", async () => {
  const requests: Request[] = [];
  const { harness, events, settled, start, sent } = await replay("edit", (request) => {
    requests.push(request);
    return { kind: "approval", decision: "session" };
  });
  await start();
  await harness.send({ text: "edit" });
  await settled();
  expect(requests[0]).toMatchObject({
    kind: "approval",
    title: "Change a file",
    files: [{ path: "greet.txt", additions: 1, deletions: 1 }],
  });
  expect(sent(/^\/permission\/.+\/reply$/)[0]?.body).toEqual({ reply: "always" });
  const change = completed(events).find((i) => i.kind === "file_change");
  expect(change).toMatchObject({ status: "done" });
  expect(change?.kind === "file_change" && change.files[0]?.patch).toContain("+world there");
  expect(change?.kind === "file_change" && change.files[0]?.path).toBe("greet.txt");
  // The read before the edit is a tool of its own.
  expect(completed(events).find((i) => i.kind === "tool")).toMatchObject({ name: "read" });
  await harness.close();
});

test("deny: opencode is told no, the call is shown declined", async () => {
  const { harness, events, settled, start, sent } = await replay("deny", () => ({
    kind: "approval",
    decision: "deny",
  }));
  await start();
  await harness.send({ text: "touch" });
  await settled();
  expect(sent(/^\/permission\/.+\/reply$/)[0]?.body).toEqual({ reply: "reject" });
  expect(completed(events).find((i) => i.kind === "command")).toMatchObject({
    command: "touch denied.txt",
    status: "declined",
  });
  await harness.close();
});

test("question: the agent's question is a dialog, its answer goes back as labels", async () => {
  const requests: Request[] = [];
  const { harness, events, settled, start, sent } = await replay("question", (request) => {
    requests.push(request);
    return { kind: "question", answers: [["Tabs"]] };
  });
  await start();
  await harness.send({ text: "ask" });
  await settled();
  expect(requests[0]).toMatchObject({
    kind: "question",
    questions: [{ header: "Indentation", options: [{ label: "Tabs" }, { label: "Spaces" }] }],
  });
  expect(sent(/^\/question\/.+\/reply$/)[0]?.body).toEqual({ answers: [["Tabs"]] });
  // The question tool itself is the dialog: not repeated in the transcript.
  expect(completed(events).some((i) => i.kind === "tool" && i.name === "question")).toBe(false);
  expect(events.find((e) => e.type === "turn.completed")).toMatchObject({ status: "completed" });
  await harness.close();
});

test("a provider's error fails the turn with its message", async () => {
  const { harness, events, settled, start } = await replay("error");
  await start();
  await harness.send({ text: "hi" });
  await settled();
  const done = events.find((e) => e.type === "turn.completed");
  expect(done).toMatchObject({ status: "failed" });
  expect(done?.type === "turn.completed" && done.error).toBeTruthy();
  await harness.close();
});

test("modes are session rules; read only also runs the plan agent", async () => {
  const { harness, start, sent } = await replay("say-ok");
  await start();
  await harness.setMode("read");
  expect(sent(/^\/session\/ses_[^/]+$/).find((c) => c.method === "PATCH")?.body).toEqual({
    permission: MODE_RULES.read,
  });
  await harness.send({ text: "look" });
  expect(sent(/prompt_async$/)[0]?.body).toMatchObject({ agent: "plan" });
  await harness.close();
});

test("the harness's commands run through opencode's command route", async () => {
  const { harness, start, sent } = await replay("say-ok");
  await start();
  expect((await harness.commands()).map((c) => c.name)).toEqual(["review"]);
  await harness.send({ text: "/review the last commit" });
  await Bun.sleep(10);
  expect(sent(/^\/session\/.+\/command$/)[0]?.body).toMatchObject({
    command: "review",
    arguments: "the last commit",
    model: `opencode/${MODEL.id}`,
  });
  expect(sent(/prompt_async$/)).toEqual([]);
  await harness.close();
});

test("models: connected providers only, effort from variants", async () => {
  const { harness, start } = await replay("say-ok");
  await start();
  const models = await harness.models();
  expect(models.map((m) => m.id)).toEqual([`opencode/${MODEL.id}`, "anthropic/claude-x"]);
  expect(models[0]).toMatchObject({
    efforts: ["high"],
    label: "MiMo V2.6 Flash Free (OpenCode Zen)",
  });
  expect(models[1]?.blocked).toBeUndefined();
  await harness.close();
});

test("Anthropic OAuth: models blocked in the picker, at setModel and before a prompt", async () => {
  const { harness, events, start, sent } = await replay("say-ok", undefined, {
    // A plugin that brings Claude's subscription login back.
    answers: { "GET /config": { plugin: ["opencode-anthropic-auth"] } },
    model: "anthropic/claude-x",
  });
  await start();
  expect(
    events.some((e) => e.type === "info.updated" && e.info.warnings?.[0]?.includes(USE_CLAUDE)),
  ).toBe(true);
  expect((await harness.models()).find((m) => m.id === "anthropic/claude-x")?.blocked).toBe(
    USE_CLAUDE,
  );
  expect(messageOf(await rejectionOf(harness.setModel("anthropic/claude-x")))).toContain(
    USE_CLAUDE,
  );
  expect(messageOf(await rejectionOf(harness.send({ text: "hi" })))).toContain(USE_CLAUDE);
  expect(sent(/prompt_async$/)).toEqual([]);
  await harness.close();
});

test("no call ever shares a session publicly", async () => {
  const { harness, start, sent, settled } = await replay("say-ok");
  await start();
  await harness.send({ text: "Reply with exactly: ok" });
  await settled();
  expect(sent(/share/)).toEqual([]);
  await harness.close();
});

/** A server answering from a table, its event stream under the test's control. */
function stub(table: Record<string, unknown>) {
  const calls: Call[] = [];
  const streams: ((event: unknown) => void)[] = [];
  const ends: (() => void)[] = [];
  let stop: (reason: string) => void = () => {};
  const server: OpencodeServer = {
    call: async (method, path, body) => {
      calls.push({ method, path, body });
      return table[`${method} ${path}`] ?? null;
    },
    events: (onEvent) =>
      new Promise<void>((resolve) => {
        streams.push(onEvent);
        ends.push(resolve);
        onEvent({ type: "server.connected", properties: {} });
      }),
    exited: new Promise<string>((resolve) => (stop = resolve)),
    kill: () => stop("killed"),
  };
  return { server, calls, streams, ends };
}

test("resume: the session's rules set again, its transcript from opencode", async () => {
  const lines = await fixture("say-ok");
  const history = lines.findLast((l) => l.dir === "in" && l.response.path.endsWith("/message"));
  const id = "ses_f203a6e3bffeO3zvS94RIarIIt";
  const { server, calls } = stub({
    ...ANSWERS,
    [`GET /session/${id}`]: { id, title: "Say ok" },
    [`GET /session/${id}/message`]: history?.dir === "in" ? history.response.body : [],
  });
  const events: HarnessEvent[] = [];
  const harness = new OpencodeHarness(
    { emit: (e) => events.push(e), env: {} },
    { opencode: () => "opencode", serve: async () => server, anthropicOAuth: async () => [] },
  );
  await harness.start({ cwd: "/project", mode: "edits", resume: id });
  expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ permission: MODE_RULES.edits });
  const restored = events.find((e) => e.type === "history");
  expect(restored?.type === "history" && restored.items.map((i) => i.kind)).toEqual([
    "user",
    "reasoning",
    "message",
  ]);
  expect(events.some((e) => e.type === "info.updated" && e.info.title === "Say ok")).toBe(true);
  await harness.close();
});

test("a lost event stream: reconnected, the turn and open requests caught up", async () => {
  const id = "ses_1";
  const { server, streams, ends } = stub({
    ...ANSWERS,
    "POST /session": { id },
    "GET /session/status": { [id]: { type: "busy" } },
    "GET /permission": [
      {
        id: "per_1",
        sessionID: id,
        permission: "bash",
        patterns: ["ls"],
        metadata: { command: "ls" },
      },
    ],
    "GET /question": [],
  });
  const events: HarnessEvent[] = [];
  const harness = new OpencodeHarness(
    { emit: (e) => events.push(e), env: {} },
    { opencode: () => "opencode", serve: async () => server, anthropicOAuth: async () => [] },
  );
  await harness.start({ cwd: "/project", mode: "ask" });
  ends[0]?.();
  for (let i = 0; i < 300 && streams.length < 2; i++) await Bun.sleep(10);
  for (let i = 0; i < 100 && !events.some((e) => e.type === "request.opened"); i++)
    await Bun.sleep(10);
  expect(events.some((e) => e.type === "notice" && e.text.includes("reconnecting"))).toBe(true);
  expect(events.some((e) => e.type === "turn.started")).toBe(true);
  expect(events.find((e) => e.type === "request.opened")).toMatchObject({
    request: { id: "per_1", command: "ls" },
  });
  // Once idle again, as the server says on the new stream.
  streams[1]?.({ type: "session.idle", properties: { sessionID: id } });
  expect(events.at(-1)).toMatchObject({ type: "turn.completed", status: "completed" });
  await harness.close();
});
