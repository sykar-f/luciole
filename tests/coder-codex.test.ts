import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { Request, Response } from "../examples/coder/components/model";
import {
  CodexHarness,
  type CodexDeps,
  type CodexTransport,
} from "../examples/coder/server/adapters/codex";
import type { HarnessEvent } from "../examples/coder/server/adapters/types";
import type { RpcHandlers } from "../examples/coder/server/jsonl";

// Exchanges recorded on the real codex app-server by scripts/coder/record-codex.ts,
// replayed in step with the adapter: its requests answered as recorded, Codex's
// notifications and requests delivered in their recorded order.
const FIXTURES = resolve("tests/fixtures/coder/codex");
const Entry = z.object({
  dir: z.enum(["in", "out"]),
  message: z.looseObject({
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string().optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional(),
  }),
});
type Entry = z.infer<typeof Entry>;
const fixture = (name: string): Entry[] =>
  readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((line) => Entry.parse(JSON.parse(line)));

type Sent =
  | { kind: "request"; method: string; params: unknown; resolve: (value: unknown) => void }
  | { kind: "notify"; method: string }
  | { kind: "reply"; id: string | number; result: unknown };

class Replay implements CodexTransport {
  readonly sent: { method?: string; id?: string | number; params?: unknown; result?: unknown }[] =
    [];
  private readonly outbox: Sent[] = [];
  private readonly waiting = new Map<string, (value: unknown) => void>();
  private readonly skipped = new Map<string, string>();
  private readonly answers = new Map<string, unknown>();
  private cursor = 0;
  private stopped: () => void = () => {};
  readonly exited = new Promise<string>((resolve) => (this.stopped = () => resolve("killed")));
  private readonly lines: readonly Entry[];
  private readonly handlers: RpcHandlers;
  constructor(lines: readonly Entry[], handlers: RpcHandlers) {
    this.lines = lines;
    this.handlers = handlers;
    // What each recorded request was answered: for a call made out of the recorded order.
    for (const line of lines) {
      if (line.dir !== "out" || !line.message.method || line.message.id === undefined) continue;
      const answer = lines.find(
        (l) => l.dir === "in" && l.message.id === line.message.id && !l.message.method,
      );
      if (answer) this.answers.set(line.message.method, answer.message.result);
    }
  }
  private laterMethods() {
    return new Set(
      this.lines
        .slice(this.cursor)
        .flatMap((l) => (l.dir === "out" && l.message.method ? [l.message.method] : [])),
    );
  }
  /** Moves through the recording as far as what the adapter sent allows. */
  private pump() {
    while (this.cursor < this.lines.length) {
      const line = this.lines[this.cursor];
      if (!line) return;
      const { id, method, params, result } = line.message;
      if (line.dir === "in") {
        this.cursor++;
        if (method !== undefined && id !== undefined) this.handlers.onRequest(id, method, params);
        else if (method !== undefined) this.handlers.onNotification(method, params);
        else if (id !== undefined && !this.skipped.has(String(id)))
          this.waiting.get(String(id))?.(result);
        continue;
      }
      // An answer to one of Codex's requests: waits for the adapter's own.
      if (method === undefined) {
        const at = this.outbox.findIndex((s) => s.kind === "reply" && String(s.id) === String(id));
        if (at < 0) return;
        this.outbox.splice(at, 1);
        this.cursor++;
        continue;
      }
      const at = this.outbox.findIndex((s) => s.kind !== "reply" && s.method === method);
      if (at >= 0) {
        const [sent] = this.outbox.splice(at, 1);
        if (sent?.kind === "request" && id !== undefined)
          this.waiting.set(String(id), sent.resolve);
        this.cursor++;
        continue;
      }
      // A request the adapter does not make here (the recorder listed models first).
      const next = this.outbox.flatMap((s) => (s.kind === "reply" ? [] : [s.method]))[0];
      if (next !== undefined && this.laterMethods().has(next)) {
        if (id !== undefined) this.skipped.set(String(id), method);
        this.cursor++;
        continue;
      }
      return;
    }
  }
  async request(method: string, params?: unknown) {
    this.sent.push({ method, params });
    // Not in what remains of the recording: answered as recorded, or empty.
    if (!this.laterMethods().has(method)) return this.answers.get(method) ?? {};
    return new Promise<unknown>((resolve) => {
      this.outbox.push({ kind: "request", method, params, resolve });
      queueMicrotask(() => this.pump());
    });
  }
  notify(method: string) {
    this.sent.push({ method });
    this.outbox.push({ kind: "notify", method });
    queueMicrotask(() => this.pump());
  }
  reply(id: string | number, result: unknown) {
    this.sent.push({ id, result });
    this.outbox.push({ kind: "reply", id, result });
    queueMicrotask(() => this.pump());
  }
  fail(id: string | number) {
    this.reply(id, { error: true });
  }
  kill() {
    this.stopped();
  }
}

function replay(
  name: string,
  answer: (request: Request) => Response = () => ({ kind: "approval", decision: "once" }),
) {
  const events: HarnessEvent[] = [];
  const transports: Replay[] = [];
  const deps: CodexDeps = {
    spawn: (handlers) => {
      const transport = new Replay(fixture(name), handlers);
      transports.push(transport);
      return transport;
    },
    codex: () => "/usr/local/bin/codex",
  };
  const harness: CodexHarness = new CodexHarness(
    {
      emit: (event) => {
        events.push(event);
        if (event.type === "request.opened")
          queueMicrotask(() => void harness.respond(event.request, answer(event.request)));
      },
      env: { PATH: "/usr/bin" },
    },
    deps,
  );
  const settled = async () => {
    for (let i = 0; i < 400 && !events.some((e) => e.type === "turn.completed"); i++)
      await Bun.sleep(5);
  };
  return { harness, events, transports, settled };
}
const completed = (events: readonly HarnessEvent[]) =>
  events.flatMap((e) => (e.type === "item.completed" ? [e.item] : []));
const sentTo = (transport: Replay | undefined, method: string) =>
  transport?.sent.find((s) => s.method === method)?.params;

test("start: an honest client name, the account without its tokens, a thread in the project", async () => {
  const { harness, events, transports } = replay("say-ok");
  await harness.start({ cwd: "/project", mode: "ask" });
  expect(sentTo(transports[0], "initialize")).toMatchObject({
    clientInfo: { name: "airtty-coder" },
    capabilities: { experimentalApi: true },
  });
  expect(sentTo(transports[0], "thread/start")).toEqual({
    cwd: "/project",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  });
  const info = events.flatMap((e) => (e.type === "info.updated" ? [e.info] : []));
  expect(info.some((i) => i.account === "user@example.com · prolite")).toBe(true);
  expect(info.some((i) => typeof i.sessionId === "string" && i.sessionId.length > 0)).toBe(true);
  await harness.close();
});

test("say ok: a streamed message, token usage and the weekly limit, a completed turn", async () => {
  const { harness, events, settled } = replay("say-ok");
  await harness.start({ cwd: "/project", mode: "ask" });
  await harness.send({ text: "Reply with exactly: ok" });
  await settled();
  expect(completed(events).find((i) => i.kind === "message")).toMatchObject({ text: "ok" });
  expect(events.some((e) => e.type === "item.delta" && e.delta === "ok")).toBe(true);
  const usage = events.flatMap((e) => (e.type === "usage.updated" ? [e.usage] : []));
  expect(usage.some((u) => u.context?.window === 258_400)).toBe(true);
  expect(usage.some((u) => u.limits?.weekly === 0)).toBe(true);
  expect(events.at(-1)).toEqual({ type: "turn.completed", status: "completed" });
  expect((await harness.models()).find((m) => m.id === "gpt-5.6-luna")?.efforts).toContain("low");
});

test("command: shown as typed, not through the login shell, with its output", async () => {
  const { harness, events, settled } = replay("command");
  await harness.start({ cwd: "/project", mode: "ask" });
  await harness.send({ text: "run echo" });
  await settled();
  expect(completed(events).find((i) => i.kind === "command")).toMatchObject({
    command: "echo coder-fixture",
    output: "coder-fixture\n",
    exitCode: 0,
    status: "done",
  });
});

test("a command approval is Codex's request, answered once with its decision", async () => {
  const requests: Request[] = [];
  const { harness, events, transports, settled } = replay("approve-command", (request) => {
    requests.push(request);
    return { kind: "approval", decision: "once" };
  });
  await harness.start({ cwd: "/project", mode: "read" });
  await harness.send({ text: "touch" });
  await settled();
  expect(requests[0]).toMatchObject({
    kind: "approval",
    command: "touch made.txt",
    detail: "May I create the requested made.txt file in the current workspace?",
    decisions: ["once", "session", "always", "deny"],
  });
  expect(transports[0]?.sent.filter((s) => s.result !== undefined)).toEqual([
    { id: 0, result: { decision: "accept" } },
  ]);
  // serverRequest/resolved closes the request on coder's side too.
  expect(events.some((e) => e.type === "request.resolved")).toBe(false);
  expect(completed(events).find((i) => i.kind === "command")).toMatchObject({ status: "done" });
});

test("a file approval shows the change's diff; accepted for the session", async () => {
  const requests: Request[] = [];
  const { harness, events, transports, settled } = replay("approve-edit", (request) => {
    requests.push(request);
    return { kind: "approval", decision: "session" };
  });
  await harness.start({ cwd: "/project", mode: "read" });
  await harness.send({ text: "edit" });
  await settled();
  expect(requests[0]).toMatchObject({
    kind: "approval",
    files: [{ path: "greet.txt", additions: 1, deletions: 1 }],
    decisions: ["once", "session", "deny"],
  });
  expect(requests[0]?.kind === "approval" && requests[0].files?.[0]?.patch).toContain(
    "--- a/greet.txt",
  );
  expect(transports[0]?.sent.find((s) => s.result !== undefined)?.result).toEqual({
    decision: "acceptForSession",
  });
  expect(completed(events).find((i) => i.kind === "file_change")).toMatchObject({ status: "done" });
});

test("in auto-edit mode a file change is accepted without asking", async () => {
  const requests: Request[] = [];
  const { harness, transports, settled } = replay("approve-edit", (request) => {
    requests.push(request);
    return { kind: "approval", decision: "deny" };
  });
  await harness.start({ cwd: "/project", mode: "edits" });
  await harness.send({ text: "edit" });
  await settled();
  expect(requests).toEqual([]);
  expect(transports[0]?.sent.find((s) => s.result !== undefined)?.result).toEqual({
    decision: "accept",
  });
});

test("read mode plans: the plan shows, and approving it implements it in ask mode", async () => {
  const { harness, events, transports, settled } = replay("plan", (request) => {
    expect(request.kind === "plan_review" && request.plan).toContain("notes.txt");
    return { kind: "plan_review", approve: true };
  });
  await harness.start({ cwd: "/project", mode: "read" });
  await harness.send({ text: "plan" });
  await settled();
  expect(sentTo(transports[0], "turn/start")).toMatchObject({
    sandboxPolicy: { type: "readOnly" },
    collaborationMode: { mode: "plan" },
  });
  expect(completed(events).some((i) => i.kind === "message" && i.text.includes("notes.txt"))).toBe(
    true,
  );
  for (
    let i = 0;
    i < 100 && !events.some((e) => e.type === "info.updated" && e.info.mode === "ask");
    i++
  )
    await Bun.sleep(5);
  expect(events.some((e) => e.type === "info.updated" && e.info.mode === "ask")).toBe(true);
  const turns = transports[0]?.sent.filter((s) => s.method === "turn/start") ?? [];
  expect(turns.at(-1)?.params).toMatchObject({
    input: [{ type: "text", text: "Implement the plan." }],
    collaborationMode: { mode: "default" },
    sandboxPolicy: { type: "workspaceWrite" },
  });
});

test("without codex on the PATH, or signed out, the adapter says what to run", async () => {
  const missing = new CodexHarness(
    { emit: () => {}, env: {} },
    {
      spawn: () => {
        throw new Error("never");
      },
      codex: () => null,
    },
  );
  expect(
    await missing.start({ cwd: "/", mode: "ask" }).then(
      () => "",
      (e: unknown) => String(e),
    ),
  ).toContain("codex is not on the PATH");
  const signedOut = new CodexHarness(
    { emit: () => {}, env: {} },
    {
      spawn: () => ({
        request: async (method: string) =>
          method === "account/read"
            ? { account: null, requiresOpenaiAuth: true }
            : { userAgent: "x/0.157.0" },
        notify: () => {},
        reply: () => {},
        fail: () => {},
        kill: () => {},
        exited: new Promise(() => {}),
      }),
      codex: () => "/usr/local/bin/codex",
    },
  );
  expect(
    await signedOut.start({ cwd: "/", mode: "ask" }).then(
      () => "",
      (e: unknown) => String(e),
    ),
  ).toContain("codex login");
});
