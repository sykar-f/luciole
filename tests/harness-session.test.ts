/**
 * `HarnessSession` (packages/harness) beyond coder's use: what a host such as studio
 * passes it. Start options reach the harness, a policy answers requests without the
 * user, the end of each turn and each finished write are told, and the host adds its own
 * lines to the transcript.
 */
import { test, expect } from "bun:test";
import type { Harness, HarnessContext, StartOptions } from "../packages/harness/src/adapters/types";
import type { Request, Response } from "../packages/harness/src/model";
import { HarnessSession } from "../packages/harness/src/session";
import { until } from "./helpers";

const NONE = {
  steer: false,
  models: false,
  effort: false,
  modes: [],
  compact: false,
  resume: false,
  newSession: false,
  planMode: false,
  images: false,
} as const;

/** A harness that asks for approval of a command, then ends its turn. */
class Asking implements Harness {
  readonly id = "fake";
  readonly capabilities = NONE;
  started: StartOptions | undefined;
  answers: { request: Request; response: Response }[] = [];
  private readonly context: HarnessContext;
  constructor(context: HarnessContext) {
    this.context = context;
  }
  async start(options: StartOptions) {
    this.started = options;
  }
  async send() {
    this.context.emit({ type: "turn.started" });
    this.context.emit({
      type: "request.opened",
      request: {
        id: "r1",
        openedAt: 0,
        kind: "approval",
        title: "Run a command",
        command: "rm -rf /",
        decisions: ["once", "deny"],
      },
    });
  }
  async respond(request: Request, response: Response) {
    this.answers.push({ request, response });
    this.context.emit({ type: "request.resolved", id: request.id });
    // A write that is still running, one that was declined, one that is done.
    const write = (status: "running" | "declined" | "done", path: string) => ({
      id: `edit-${path}`,
      kind: "file_change" as const,
      files: [{ path, patch: "", additions: 1, deletions: 0 }],
      status,
    });
    this.context.emit({ type: "item.started", item: write("running", "app/page.tsx") });
    this.context.emit({ type: "item.completed", item: write("declined", "package.json") });
    this.context.emit({ type: "item.completed", item: write("done", "app/page.tsx") });
    this.context.emit({ type: "turn.completed", status: "completed" });
  }
  async steer() {}
  async interrupt() {}
  async setModel() {}
  async setMode() {}
  async compact() {}
  async newSession() {}
  async resume() {}
  async listSessions() {
    return [];
  }
  async models() {
    return [];
  }
  async commands() {
    return [];
  }
  async close() {}
}

test("a host's start options, policy and turn hook reach the harness and the session", async () => {
  let harness: Asking | undefined;
  const turns: string[] = [];
  const written: string[] = [];
  const session = new HarnessSession({
    harness: "fake",
    cwd: "/project",
    mode: "ask",
    create: (_id, context) => (harness = new Asking(context)),
    pick: async (id) => ({ id: id ?? "fake", installed: true, ready: true, warnings: [] }),
    start: {
      client: "luciole-studio",
      instructions: "Write luciole apps.",
      tools: ["Read"],
      isolated: true,
    },
    // Commands are never run: refused without asking the user.
    policy: (request) =>
      request.kind === "approval" && request.command
        ? { kind: "approval", decision: "deny" }
        : undefined,
    onTurnCompleted: (status) => void turns.push(status),
    onFilesWritten: (files) => void written.push(...files.map((f) => f.path)),
  });
  await session.start();
  expect(harness?.started).toEqual({
    client: "luciole-studio",
    instructions: "Write luciole apps.",
    tools: ["Read"],
    isolated: true,
    cwd: "/project",
    mode: "ask",
    model: undefined,
    effort: undefined,
    resume: undefined,
  });
  expect((await session.send("make an app")).ok).toBe(true);
  await until(() => turns.length === 1);
  expect(harness?.answers.map((a) => a.response)).toEqual([{ kind: "approval", decision: "deny" }]);
  // The user never saw it, and answering it again is a no-op.
  expect(session.snapshot().requests).toEqual([]);
  expect(session.requestState("r1")).toEqual({
    state: "answered",
    response: { kind: "approval", decision: "deny" },
  });
  expect(turns).toEqual(["completed"]);
  // Only a finished write is told: studio previews files the harness has written.
  expect(written).toEqual(["app/page.tsx"]);
  session.note("info", "Build ✓ · revision r1");
  expect(session.snapshot().items.at(-1)).toMatchObject({
    kind: "notice",
    level: "info",
    text: "Build ✓ · revision r1",
  });
});
