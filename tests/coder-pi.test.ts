import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { Request, Response } from "../packages/harness/src/model";
import { USE_CLAUDE } from "../packages/harness/src/anthropic-guard";
import { PiHarness, type PiDeps } from "../packages/harness/src/adapters/pi";
import type { HarnessEvent } from "../packages/harness/src/adapters/types";
import { messageOf } from "../packages/core/src/guards";
import { rejectionOf, until, WAIT_MS } from "./helpers";

// Exchanges recorded on the real pi 0.87.1 with coder's gate by scripts/coder/record-pi.ts,
// replayed in step with the adapter.
const FIXTURES = resolve("tests/fixtures/coder/pi");
const Entry = z.object({
  dir: z.enum(["in", "out"]),
  message: z.looseObject({ type: z.string(), id: z.string().optional() }),
});
type Entry = z.infer<typeof Entry>;
const fixture = async (name: string): Promise<Entry[]> =>
  (await readFile(join(FIXTURES, `${name}.jsonl`), "utf8"))
    .trim()
    .split("\n")
    .map((line) => Entry.parse(JSON.parse(line)));
const Sent = z.looseObject({ type: z.string(), id: z.string().optional() });

class Replay {
  readonly written: z.infer<typeof Sent>[] = [];
  private readonly outbox: z.infer<typeof Sent>[] = [];
  private readonly ids = new Map<string, string>();
  private cursor = 0;
  private stop: (reason: string) => void = () => {};
  readonly exited = new Promise<string>((resolve) => (this.stop = resolve));
  private readonly lines: readonly Entry[];
  private readonly onLine: (line: string) => void;
  constructor(lines: readonly Entry[], onLine: (line: string) => void) {
    this.lines = lines;
    this.onLine = onLine;
  }
  private pump() {
    while (this.cursor < this.lines.length) {
      const line = this.lines[this.cursor];
      if (!line) return;
      const m = line.message;
      if (line.dir === "in") {
        this.cursor++;
        const id = m.type === "response" && m.id ? this.ids.get(m.id) : undefined;
        if (m.type === "response" && !id) continue;
        this.onLine(JSON.stringify(id ? { ...m, id } : m));
        continue;
      }
      const at = this.outbox.findIndex(
        (s) => s.type === m.type && (m.type !== "extension_ui_response" || s.id === m.id),
      );
      if (at < 0) {
        // A command the adapter does not send here: its answer is not delivered.
        const next = this.outbox[0];
        if (next && next.type !== m.type && m.type !== "extension_ui_response" && m.id) {
          this.cursor++;
          continue;
        }
        return;
      }
      const [sent] = this.outbox.splice(at, 1);
      if (m.id && sent?.id) this.ids.set(m.id, sent.id);
      this.cursor++;
    }
    // Past the recording: commands are answered empty, as pi answers a successful one.
    for (const sent of this.outbox.splice(0))
      if (sent.id && sent.type !== "extension_ui_response")
        this.onLine(
          JSON.stringify({
            type: "response",
            id: sent.id,
            command: sent.type,
            success: true,
            data: {},
          }),
        );
  }
  write(value: unknown) {
    const sent = Sent.parse(value);
    this.written.push(sent);
    this.outbox.push(sent);
    queueMicrotask(() => this.pump());
    return true;
  }
  kill() {
    this.stop("killed");
  }
}

let project: string;
beforeAll(async () => {
  project = await mkdtemp(join(tmpdir(), "coder-pi-"));
  await writeFile(join(project, "greet.txt"), "hello there\n");
});
afterAll(() => rm(project, { recursive: true, force: true }));

async function replay(
  name: string,
  answer: (request: Request) => Response = () => ({ kind: "approval", decision: "once" }),
  options: { blocked?: readonly string[]; env?: NodeJS.ProcessEnv } = {},
) {
  const blocked = options.blocked ?? [];
  const env = options.env ?? { PATH: "/usr/bin" };
  const events: HarnessEvent[] = [];
  const spawned: { argv: readonly string[]; env: NodeJS.ProcessEnv; process: Replay }[] = [];
  const lines = await fixture(name);
  const deps: PiDeps = {
    spawn: (argv, options) => {
      const process = new Replay(lines, options.onLine);
      spawned.push({ argv, env: options.env, process });
      return process;
    },
    pi: () => "/usr/local/bin/pi",
    anthropicOAuth: async () => blocked,
    sessions: () => join(project, "no-sessions"),
  };
  const harness: PiHarness = new PiHarness(
    {
      emit: (event) => {
        events.push(event);
        if (event.type === "request.opened")
          queueMicrotask(() => void harness.respond(event.request, answer(event.request)));
      },
      env,
    },
    deps,
  );
  // The turn is over once the usage pi's stats give after its end is in: the adapter
  // completes the turn, then asks for the stats (PiHarness.settled).
  const settled = () =>
    until(
      () => {
        const end = events.findIndex((e) => e.type === "turn.completed");
        return end >= 0 && events.slice(end).some((e) => e.type === "usage.updated");
      },
      WAIT_MS,
      () => events.map((e) => e.type).join("\n"),
    );
  return { harness, events, spawned, settled };
}
const completed = (events: readonly HarnessEvent[]) =>
  events.flatMap((e) => (e.type === "item.completed" ? [e.item] : []));

test("pi runs with coder's gate, its mode, no project trust, and no Anthropic OAuth token", async () => {
  const { harness, spawned } = await replay("say-ok", undefined, {
    env: {
      PATH: "/usr/bin",
      ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat-x",
      ANTHROPIC_AUTH_TOKEN: "t",
      ANTHROPIC_API_KEY: "sk-ant-oat-y",
    },
  });
  await harness.start({ cwd: project, mode: "read" });
  const [run] = spawned;
  expect(run?.argv.slice(0, 4)).toEqual(["/usr/local/bin/pi", "--mode", "rpc", "--session-id"]);
  expect(run?.argv).toContain("--no-approve");
  expect(run?.argv.join(" ")).toMatch(
    /-e \S+coder-gate\.js --coder-mode read --tools read,grep,find,ls/,
  );
  expect(run?.env).toEqual({ PATH: "/usr/bin" });
  await harness.close();
});

test("say ok: the reply, usage and context from pi's stats, a settled turn", async () => {
  const { harness, events, settled } = await replay("say-ok");
  await harness.start({ cwd: project, mode: "ask" });
  // As recorded: the mode set through the gate's command first, no model call for it.
  await harness.setMode("ask");
  await harness.send({ text: "Reply with exactly: ok" });
  await settled();
  expect(completed(events).find((i) => i.kind === "message")).toMatchObject({ text: "ok" });
  expect(
    events.some((e) => e.type === "info.updated" && e.info.model === "openai-codex/gpt-5.6-luna"),
  ).toBe(true);
  expect(events.find((e) => e.type === "turn.completed")).toEqual({
    type: "turn.completed",
    status: "completed",
  });
  const usage = events.flatMap((e) => (e.type === "usage.updated" ? [e.usage] : []));
  expect(usage.at(-1)).toMatchObject({ context: { window: 272_000 } });
  expect((usage.at(-1)?.costUsd ?? 0) > 0).toBe(true);
});

test("bash: the gate's question is an approval; allowed once, the command runs", async () => {
  const requests: Request[] = [];
  const { harness, events, spawned, settled } = await replay("bash", (request) => {
    requests.push(request);
    return { kind: "approval", decision: "once" };
  });
  await harness.start({ cwd: project, mode: "ask" });
  await harness.send({ text: "echo" });
  await settled();
  expect(requests[0]).toMatchObject({
    kind: "approval",
    title: "Run a command",
    command: "echo coder-fixture",
    decisions: ["once", "session", "deny"],
  });
  expect(spawned[0]?.process.written.find((w) => w.type === "extension_ui_response")).toMatchObject(
    { value: "Allow once" },
  );
  expect(completed(events).find((i) => i.kind === "command")).toMatchObject({
    output: "coder-fixture\n",
    status: "done",
  });
});

test("edit: the approval shows the file's diff; the change keeps pi's patch", async () => {
  const requests: Request[] = [];
  const { harness, events, settled } = await replay("edit", (request) => {
    requests.push(request);
    return { kind: "approval", decision: "session" };
  });
  await harness.start({ cwd: project, mode: "ask" });
  await harness.send({ text: "edit" });
  await settled();
  expect(requests[0]).toMatchObject({
    kind: "approval",
    files: [{ path: "greet.txt", additions: 1, deletions: 1 }],
  });
  const change = completed(events).find((i) => i.kind === "file_change");
  expect(change).toMatchObject({ status: "done" });
  expect(change?.kind === "file_change" && change.files[0]?.patch).toContain("+world there");
});

test("deny: pi is told no, the call is shown declined", async () => {
  const { harness, events, spawned, settled } = await replay("deny", () => ({
    kind: "approval",
    decision: "deny",
  }));
  await harness.start({ cwd: project, mode: "ask" });
  await harness.send({ text: "touch" });
  await settled();
  expect(spawned[0]?.process.written.find((w) => w.type === "extension_ui_response")).toMatchObject(
    { value: "Deny" },
  );
  expect(completed(events).find((i) => i.kind === "command")).toMatchObject({ status: "declined" });
});

test("Anthropic OAuth: models blocked in the picker, at set_model and before a prompt", async () => {
  const { harness, events, spawned } = await replay("say-ok", undefined, {
    blocked: ["pi's auth.json holds an Anthropic OAuth login"],
  });
  await harness.start({ cwd: project, mode: "ask" });
  expect(
    events.some((e) => e.type === "info.updated" && e.info.warnings?.[0]?.includes(USE_CLAUDE)),
  ).toBe(true);
  expect(messageOf(await rejectionOf(harness.setModel("anthropic/claude-sonnet-4")))).toBe(
    USE_CLAUDE,
  );
  expect(spawned[0]?.process.written.some((w) => w.type === "set_model")).toBe(false);
  // The session's model is Anthropic's (pi's default, for instance): no prompt goes out.
  Reflect.set(harness, "provider", "anthropic");
  expect(messageOf(await rejectionOf(harness.send({ text: "hi" })))).toContain(USE_CLAUDE);
  await harness.close();
});

test("modes change through the gate's command, not pi's model", async () => {
  const { harness, spawned } = await replay("say-ok");
  await harness.start({ cwd: project, mode: "ask" });
  await harness.setMode("edits");
  expect(spawned[0]?.process.written.find((w) => w.type === "prompt")).toMatchObject({
    message: "/coder-mode edits",
  });
  await harness.close();
});
