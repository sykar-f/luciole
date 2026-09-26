import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type {
  PermissionResult,
  PermissionUpdate,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Request, Response } from "../examples/coder/components/model";
import {
  ClaudeHarness,
  type ClaudeDeps,
  type QueryLike,
  type QueryOptions,
} from "../examples/coder/server/adapters/claude";
import type { HarnessEvent } from "../examples/coder/server/adapters/types";
import { messageOf } from "../packages/airtty/src/guards";
import { rejectionOf } from "./helpers";

// Streams recorded on the real claude 2.1.283 by scripts/coder/record-claude.ts, replayed
// through the adapter: the contract is the neutral events it gives for each of them.
const FIXTURES = resolve("tests/fixtures/coder/claude");
const Line = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("init"), result: z.unknown() }),
  z.object({ kind: z.literal("message"), message: z.unknown() }),
  z.object({
    kind: z.literal("can_use_tool"),
    tool: z.string(),
    input: z.record(z.string(), z.unknown()),
    options: z.looseObject({
      toolUseID: z.string(),
      suggestions: z
        .array(z.custom<PermissionUpdate>((v) => typeof v === "object" && v !== null))
        .optional(),
    }),
  }),
  z.object({ kind: z.literal("answer"), answer: z.unknown() }),
  z.object({ kind: z.literal("error"), message: z.string() }),
]);
type Line = z.infer<typeof Line>;
const fixture = (name: string): Line[] =>
  readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((line) => Line.parse(JSON.parse(line)));

/** A query that plays a recording once the adapter sent its first message. */
class Replay implements QueryLike {
  readonly calls: string[] = [];
  readonly answers: PermissionResult[] = [];
  private closed = false;
  private readonly lines: readonly Line[];
  private readonly prompt: AsyncIterable<SDKUserMessage>;
  private readonly options: QueryOptions;
  constructor(
    lines: readonly Line[],
    prompt: AsyncIterable<SDKUserMessage>,
    options: QueryOptions,
  ) {
    this.lines = lines;
    this.prompt = prompt;
    this.options = options;
  }
  private stop: () => void = () => {};
  private readonly stopped = new Promise<void>((resolve) => (this.stop = resolve));
  async *[Symbol.asyncIterator]() {
    // An idle query (one opened to resume) waits, as the real one waits for a prompt.
    if (!this.lines.some((l) => l.kind === "message")) {
      await this.stopped;
      return;
    }
    // Nothing happens until the user speaks.
    for await (const _first of this.prompt) break;
    for (const line of this.lines) {
      if (this.closed) return;
      if (line.kind === "message") yield line.message;
      else if (line.kind === "error") throw new Error(line.message);
      else if (line.kind === "can_use_tool") {
        const answer = await this.options.canUseTool?.(line.tool, line.input, {
          signal: new AbortController().signal,
          suggestions: line.options.suggestions,
          toolUseID: line.options.toolUseID,
          requestId: line.options.toolUseID,
        });
        if (answer) this.answers.push(answer);
      }
    }
    // After its last result, the real query waits for the next prompt.
    await this.stopped;
  }
  async interrupt() {
    this.calls.push("interrupt");
  }
  async setPermissionMode(mode: string) {
    this.calls.push(`mode ${mode}`);
  }
  async setModel(model?: string) {
    this.calls.push(`model ${model}`);
  }
  async applyFlagSettings(settings: { effortLevel?: string | null }) {
    this.calls.push(`effort ${settings.effortLevel}`);
  }
  async initializationResult() {
    return this.lines.find((l) => l.kind === "init")?.kind === "init"
      ? this.lines.flatMap((l) => (l.kind === "init" ? [l.result] : []))[0]
      : {};
  }
  close() {
    this.closed = true;
    this.stop();
  }
}

/** The adapter on a recording; `answer` decides each request it opens. */
function replay(
  name: string,
  answer: (request: Request) => Response = () => ({ kind: "approval", decision: "once" }),
  /** The messages Claude Code stored for any session asked about. */
  stored: readonly unknown[] = [],
) {
  const events: HarnessEvent[] = [];
  const queries: { options: QueryOptions; query: Replay }[] = [];
  const lines = fixture(name);
  const deps: ClaudeDeps = {
    query: ({ prompt, options }) => {
      // The first query plays the recording; one opened after it (a resume) is idle.
      const query = new Replay(queries.length ? [] : lines, prompt, options);
      queries.push({ options, query });
      return query;
    },
    listSessions: async () => [],
    getSessionMessages: async () => stored,
    claude: () => "/usr/local/bin/claude",
  };
  const harness: ClaudeHarness = new ClaudeHarness(
    {
      emit: (event) => {
        events.push(event);
        if (event.type === "request.opened")
          queueMicrotask(() => void harness.respond(event.request, answer(event.request)));
      },
      env: { PATH: "/usr/bin", HOME: "/home/ada", ANTHROPIC_API_KEY: undefined },
    },
    deps,
  );
  const settled = async () => {
    for (let i = 0; i < 200 && !events.some((e) => e.type === "turn.completed"); i++)
      await Bun.sleep(5);
  };
  return { harness, events, queries, settled };
}
const completed = (events: readonly HarnessEvent[]) =>
  events.flatMap((e) => (e.type === "item.completed" ? [e.item] : []));

test("the SDK runs the user's own claude, with Claude Code's prompt and settings", async () => {
  const { harness, queries } = replay("say-ok");
  await harness.start({ cwd: "/project", mode: "ask", model: "haiku", effort: "low" });
  const [first] = queries;
  expect(first?.options).toMatchObject({
    cwd: "/project",
    pathToClaudeCodeExecutable: "/usr/local/bin/claude",
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["user", "project", "local"],
    permissionMode: "default",
    includePartialMessages: true,
    thinking: { type: "adaptive", display: "summarized" },
    model: "haiku",
    effort: "low",
  });
  // The whole environment: without HOME and PATH, the keychain login is lost.
  expect(first?.options.env).toMatchObject({ PATH: "/usr/bin", HOME: "/home/ada" });
  expect(first?.options.allowDangerouslySkipPermissions).toBeUndefined();
  expect(JSON.stringify(first?.options)).not.toContain("bare");
  await harness.close();
});

test("the SDK's own binary is not installed: only the user's claude can run", () => {
  expect(() =>
    Bun.resolveSync(
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`,
      import.meta.dir,
    ),
  ).toThrow();
});

test("without claude on the PATH, the adapter says how to get it", async () => {
  const harness = new ClaudeHarness(
    { emit: () => {}, env: {} },
    {
      query: () => {
        throw new Error("never");
      },
      listSessions: async () => [],
      getSessionMessages: async () => [],
      claude: () => null,
    },
  );
  expect(messageOf(await rejectionOf(harness.start({ cwd: "/", mode: "ask" })))).toContain(
    "claude is not on the PATH",
  );
});

test("say ok: streamed thinking and text, usage and plan limits, a completed turn", async () => {
  const { harness, events, settled } = replay("say-ok");
  await harness.start({ cwd: "/project", mode: "ask" });
  await harness.send({ text: "Reply with exactly: ok" });
  await settled();
  const items = completed(events);
  expect(items.find((i) => i.kind === "message")).toMatchObject({ text: "ok", streaming: false });
  expect(items.some((i) => i.kind === "reasoning")).toBe(true);
  expect(events.some((e) => e.type === "item.delta")).toBe(true);
  const usage = events.flatMap((e) => (e.type === "usage.updated" ? [e.usage] : []));
  expect(usage.some((u) => u.limits?.fiveHour !== undefined && u.limits.weekly !== undefined)).toBe(
    true,
  );
  expect(usage.some((u) => u.context?.window === 200_000 && (u.costUsd ?? 0) > 0)).toBe(true);
  const reported = events.flatMap((e) =>
    e.type === "info.updated" && e.info.version ? [e.info] : [],
  );
  expect(reported[0]?.model).toBe("claude-haiku-4-5-20251001");
  expect(reported[0]?.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(events.at(-1)).toEqual({ type: "turn.completed", status: "completed" });
  expect((await harness.models()).find((m) => m.id === "opus")?.efforts).toContain("max");
  expect((await harness.commands()).length).toBeGreaterThan(0);
  await harness.close();
});

test("bash: a command item with the command and its output", async () => {
  const { harness, events, settled } = replay("bash");
  await harness.start({ cwd: "/project", mode: "ask" });
  await harness.send({ text: "run echo" });
  await settled();
  expect(completed(events).find((i) => i.kind === "command")).toMatchObject({
    command: "echo coder-fixture",
    output: "coder-fixture",
    status: "done",
  });
});

test("edit: an approval with the file's diff, then the change with the whole file's patch", async () => {
  const requests: Request[] = [];
  const { harness, events, queries, settled } = replay("edit", (request) => {
    requests.push(request);
    return { kind: "approval", decision: "session" };
  });
  await harness.start({ cwd: "/project", mode: "ask" });
  await harness.send({ text: "edit greet.txt" });
  await settled();
  const [approval] = requests;
  expect(approval).toMatchObject({ kind: "approval", decisions: ["once", "session", "deny"] });
  const change = completed(events).find((i) => i.kind === "file_change");
  expect(change).toMatchObject({
    status: "done",
    files: [{ path: "greet.txt", additions: 1, deletions: 1 }],
  });
  expect(change?.kind === "file_change" && change.files[0]?.patch).toContain("+world there");
  // "For this session" hands the SDK's own suggestion back.
  expect(queries[0]?.query.answers[0]).toMatchObject({
    behavior: "allow",
    updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
  });
});

test("question: AskUserQuestion becomes a question; the answer goes back by question", async () => {
  const { harness, events, queries, settled } = replay("question", (request) => {
    expect(request).toMatchObject({
      kind: "question",
      questions: [{ header: "Indentation", options: [{ label: "Tabs" }, { label: "Spaces" }] }],
    });
    return { kind: "question", answers: [["Spaces"]] };
  });
  await harness.start({ cwd: "/project", mode: "ask" });
  await harness.send({ text: "ask me" });
  await settled();
  const given = queries[0]?.query.answers[0];
  expect(given?.behavior).toBe("allow");
  expect(given?.behavior === "allow" ? given.updatedInput?.answers : undefined).toEqual({
    "Do you prefer tabs or spaces for indentation?": "Spaces",
  });
  expect(events.at(-1)).toEqual({ type: "turn.completed", status: "completed" });
});

test("plan: ExitPlanMode is a plan review; after the SDK's error end, the session goes on", async () => {
  const { harness, events, queries, settled } = replay("plan", (request) => {
    expect(request.kind === "plan_review" && request.plan).toContain("notes.txt");
    return { kind: "plan_review", approve: false, feedback: "shorter" };
  });
  await harness.start({ cwd: "/project", mode: "read" });
  expect(queries[0]?.options.permissionMode).toBe("plan");
  await harness.send({ text: "plan it" });
  await settled();
  expect(queries[0]?.query.answers[0]).toEqual({
    behavior: "deny",
    message: "Keep planning: shorter",
  });
  // Recorded with a deny that also stopped the turn: Claude ends it as aborted.
  expect(events.find((e) => e.type === "turn.completed")).toMatchObject({ status: "interrupted" });
  // The stream threw after its error result: a new query resumes the same session.
  for (let i = 0; i < 100 && queries.length < 2; i++) await Bun.sleep(5);
  expect(queries).toHaveLength(2);
  // The session the CLI reported (system/init), which a resume must name.
  const init = fixture("plan").flatMap((l) =>
    l.kind === "message"
      ? [z.looseObject({ subtype: z.literal("init"), session_id: z.string() }).safeParse(l.message)]
      : [],
  );
  const reported = init.find((p) => p.success)?.data?.session_id;
  expect(reported).toBeDefined();
  expect(queries[1]?.options.resume).toBe(reported);
  expect(events.some((e) => e.type === "exited")).toBe(false);
  await harness.close();
});

test("modes map to Claude's; full access stays in the same query", async () => {
  const { harness, queries } = replay("say-ok");
  await harness.start({ cwd: "/project", mode: "ask" });
  await harness.setMode("edits");
  expect(queries[0]?.query.calls).toContain("mode acceptEdits");
  await harness.setMode("full");
  // Not bypassPermissions: it would never consult canUseTool (questions, plans).
  expect(queries).toHaveLength(1);
  expect(queries[0]?.query.calls.at(-1)).toBe("mode default");
  await harness.setModel("opus", "max");
  expect(queries[0]?.query.calls.slice(-2)).toEqual(["model opus", "effort max"]);
  await harness.close();
});

test("full access: tools run without asking, questions still reach the user", async () => {
  const edit = replay("edit", () => {
    throw new Error("full access asks nothing");
  });
  await edit.harness.start({ cwd: "/project", mode: "full" });
  expect(edit.queries[0]?.options).toMatchObject({ permissionMode: "default" });
  await edit.harness.send({ text: "run it" });
  await edit.settled();
  expect(edit.events.some((e) => e.type === "request.opened")).toBe(false);
  expect(edit.queries[0]?.query.answers.length).toBeGreaterThan(0);
  expect(edit.queries[0]?.query.answers.every((a) => a.behavior === "allow")).toBe(true);
  // Claude reports its own mode, `default`: the status line keeps full access.
  expect(edit.events.some((e) => e.type === "info.updated" && e.info.mode === "ask")).toBe(false);
  await edit.harness.close();

  const question = replay("question", () => ({ kind: "question", answers: [["Tabs"]] }));
  await question.harness.start({ cwd: "/project", mode: "full" });
  await question.harness.send({ text: "ask me" });
  await question.settled();
  expect(question.events.some((e) => e.type === "request.opened")).toBe(true);
  await question.harness.close();
});

test("resume: a session Claude Code never wrote starts anew instead of failing", async () => {
  const missing = replay("say-ok");
  await missing.harness.start({ cwd: "/project", mode: "ask", resume: "never-written" });
  expect(missing.queries[0]?.options.resume).toBeUndefined();
  expect(missing.events.some((e) => e.type === "notice" && e.text.includes("never-written"))).toBe(
    true,
  );
  await missing.harness.close();

  const stored = replay("say-ok", undefined, [{ type: "user" }]);
  await stored.harness.start({ cwd: "/project", mode: "ask", resume: "written" });
  expect(stored.queries[0]?.options.resume).toBe("written");
  await stored.harness.close();
});
