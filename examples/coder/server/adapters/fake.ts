import { z } from "zod";
import type {
  Capabilities,
  CommandInfo,
  Item,
  Mode,
  ModelInfo,
  Request,
  Response,
  SessionSummary,
} from "../../components/model";
import { filePatch } from "../diff";
import type { Harness, HarnessContext, StartOptions, UserInput } from "./types";

/**
 * A scripted harness: no process, no model, no quota. What it does depends on words in
 * the prompt, so that tests, the web demo and a first look at the UI go through every
 * kind of item and request:
 *
 *   run / test      a command with streamed output
 *   edit / fix      a file change, approved first in "ask" mode
 *   question        a question with options
 *   plan            a plan to review, then its steps
 *   agent / task    a subagent
 *   search / tool   a generic tool call
 *   slow            a long command, for interrupting
 *   fail            a failed turn
 *   compact         a compaction
 *   markdown        a long, rich Markdown reply in small pieces ("chars": 3 at a time)
 *   anything else   reasoning, then a Markdown reply
 */
const DEFAULT_DELAY_MS = 25;
const Environment = z.object({
  // Pause between streamed chunks; tests set it to 1.
  CODER_FAKE_DELAY_MS: z.coerce.number().int().min(0).default(DEFAULT_DELAY_MS),
});
const SLOW_TICKS = 150;
const SLOW_TICK_FACTOR = 8;
// However fast the script runs, the slow command lasts long enough to be interrupted.
const SLOW_TICK_MIN_MS = 50;
const CONTEXT_WINDOW = 200_000;
const TOKENS_PER_TURN = 1800;
const PERCENT = 100;
const HOUR_MS = 3_600_000;
const FIVE_HOURS = 5;
const FIVE_HOURS_MS = FIVE_HOURS * HOUR_MS;
const TITLE_LENGTH = 60;
// Percent of the fake five-hour and weekly limits a turn uses.
const FIVE_HOUR_PER_TURN = 3;
const OUTPUT_RATIO = 4;
const SUBAGENT_TOOLS = 4;
const INTERRUPTED_EXIT = 130;
const COST_PER_TURN = 0.0042;

const MODELS: readonly ModelInfo[] = [
  {
    id: "fake-large",
    label: "Fake Large",
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
  { id: "fake-small", label: "Fake Small", efforts: [] },
];
const COMMANDS: readonly CommandInfo[] = [
  { name: "review", description: "Review the changes of this session", source: "harness" },
  { name: "explain", description: "Explain the project's layout", source: "harness" },
];
const CAPABILITIES: Capabilities = {
  steer: true,
  models: true,
  effort: true,
  modes: ["read", "ask", "edits", "full"],
  compact: true,
  resume: true,
  newSession: true,
  planMode: true,
  images: false,
};

const REPLY = `Here is what I found in **this project**:

- the entry point is \`src/index.ts\`;
- tests live in \`tests/\` and run with \`bun test\`.

\`\`\`ts
export function greet(name: string) {
  return \`Hello, \${name}!\`;
}
\`\`\`

Ask me to *run the tests*, *edit* a file, or to *plan* a change.`;

// The rich reply: sections cycling through what a streamed Markdown renderer must hold still.
const SECTIONS = 12;
const CODE_EVERY = 3;
const TABLE_EVERY = 4;
const QUOTE_EVERY = 5;
/** The last line of the rich reply: tests wait for it. */
export const MARKDOWN_END = "That is all for the Markdown tour.";
const section = (n: number) =>
  [
    `## Section ${n}`,
    `Paragraph ${n} has **strong words**, *emphasis*, \`inline code\` and a ` +
      `[link](https://example.com/section/${n}); it runs long enough to wrap in a narrow ` +
      `terminal, which is where a changing length would move every line below it.`,
    `- first point of section ${n}\n- second point, with **bold** inside\n` +
      `  - nested detail\n  - another *nested* detail\n- third point`,
    n % CODE_EVERY === 0
      ? `\`\`\`ts\nexport function step${n}(input: number) {\n  const doubled = input * 2;\n` +
        `  return doubled + ${n};\n}\n\`\`\``
      : "",
    n % TABLE_EVERY === 0
      ? `| Name | Kind | Notes |\n| --- | --- | --- |\n| alpha | first | the **leader** |\n` +
        `| beta | second | a longer note in a cell |\n| gamma | third | \`code\` too |`
      : "",
    n % QUOTE_EVERY === 0 ? `> A quoted remark with **weight**,\n> on two lines.` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
export const MARKDOWN_REPLY = [
  "# A tour of Markdown",
  ...Array.from({ length: SECTIONS }, (_, i) => section(i + 1)),
  "---",
  MARKDOWN_END,
].join("\n\n");
const WORDS = /\S+\s*/g;
const THREE_CHARS = /[\s\S]{1,3}/g;

const BEFORE = `export function greet(name: string) {\n  return "Hello " + name;\n}\n`;
const AFTER = `export function greet(name: string) {\n  return \`Hello, \${name}!\`;\n}\n`;

class Interrupted extends Error {}

type FakeSession = { id: string; title: string; updatedAt: number; items: Item[] };

export class FakeHarness implements Harness {
  readonly id = "fake" as const;
  readonly capabilities = CAPABILITIES;
  private readonly delay: number;
  private readonly sessions = new Map<string, FakeSession>();
  private current: FakeSession = this.fresh();
  private mode: Mode = "ask";
  private model = "fake-large";
  private effort = "medium";
  private turn: AbortController | null = null;
  private readonly pending = new Map<string, (response: Response) => void>();
  private next = 0;
  private turns = 0;
  private readonly context: HarnessContext;

  constructor(context: HarnessContext) {
    this.context = context;
    this.delay = Environment.parse(context.env).CODER_FAKE_DELAY_MS;
  }

  private fresh(id: string = crypto.randomUUID()): FakeSession {
    const session = { id, title: "New session", updatedAt: Date.now(), items: [] };
    this.sessions.set(id, session);
    return session;
  }
  private nextId(prefix: string) {
    return `${prefix}-${++this.next}`;
  }
  private emit = (event: Parameters<HarnessContext["emit"]>[0]) => {
    if (event.type === "item.completed") this.current.items.push(event.item);
    this.context.emit(event);
  };
  private async pause(signal: AbortSignal, factor = 1, minimum = 0) {
    if (signal.aborted) throw new Interrupted();
    const ms = Math.max(this.delay * factor, minimum);
    if (ms) await Bun.sleep(ms);
    if (signal.aborted) throw new Interrupted();
  }
  private announce() {
    this.emit({
      type: "info.updated",
      info: {
        sessionId: this.current.id,
        title: this.current.title,
        model: this.model,
        effort: this.effort,
        mode: this.mode,
        account: "demo@example.com",
      },
    });
  }

  async start(options: StartOptions) {
    this.mode = options.mode;
    this.model = options.model ?? this.model;
    this.effort = options.effort ?? this.effort;
    const resumed =
      options.resume === true
        ? [...this.sessions.values()].at(-1)
        : options.resume
          ? (this.sessions.get(options.resume) ?? this.fresh(options.resume))
          : undefined;
    if (resumed) {
      this.current = resumed;
      this.emit({ type: "history", items: resumed.items });
    }
    this.announce();
  }

  async send({ text }: UserInput) {
    this.current.items.push({ id: this.nextId("user"), kind: "user", text });
    if (this.current.title === "New session") this.current.title = text.slice(0, TITLE_LENGTH);
    this.current.updatedAt = Date.now();
    const turn = new AbortController();
    this.turn = turn;
    void this.play(text, turn.signal).then(
      () => this.finish(turn, "completed"),
      (error: unknown) =>
        error instanceof Interrupted
          ? this.finish(turn, "interrupted")
          : this.finish(turn, "failed", error instanceof Error ? error.message : String(error)),
    );
  }

  private finish(
    turn: AbortController,
    status: "completed" | "interrupted" | "failed",
    error?: string,
  ) {
    if (this.turn === turn) this.turn = null;
    for (const [id, resolve] of this.pending) {
      resolve({ kind: "cancel" });
      this.pending.delete(id);
      this.emit({ type: "request.resolved", id });
    }
    this.turns++;
    this.emit({
      type: "usage.updated",
      usage: {
        context: {
          used: Math.min(CONTEXT_WINDOW, this.turns * TOKENS_PER_TURN),
          window: CONTEXT_WINDOW,
        },
        limits: {
          fiveHour: Math.min(PERCENT, this.turns * FIVE_HOUR_PER_TURN),
          weekly: Math.min(PERCENT, this.turns),
          resetsAt: Date.now() + FIVE_HOURS_MS,
        },
        costUsd: this.turns * COST_PER_TURN,
        tokens: {
          input: this.turns * TOKENS_PER_TURN,
          output: this.turns * (TOKENS_PER_TURN / OUTPUT_RATIO),
        },
      },
    });
    this.emit({ type: "turn.completed", status, ...(error ? { error } : {}) });
  }

  private async play(text: string, signal: AbortSignal) {
    this.emit({ type: "turn.started" });
    const words = text.toLowerCase();
    if (/\bfail|\berror/.test(words)) {
      await this.pause(signal);
      throw new Error("The fake model is overloaded (529): try again");
    }
    if (/\bmarkdown\b/.test(words))
      return this.message(signal, MARKDOWN_REPLY, /\bchars?\b/.test(words) ? THREE_CHARS : WORDS);
    if (/\bslow|\bsleep|\blong/.test(words)) return this.slow(signal);
    if (/\bplan/.test(words)) return this.planned(signal);
    if (/\bquestion|\bchoose/.test(words)) return this.question(signal);
    if (/\bedit|\bfix|\bchange/.test(words)) return this.edit(signal);
    if (/\brun\b|\btest/.test(words)) return this.command(signal, "bun test", TEST_OUTPUT);
    if (/\bagent|\btask|\bexplore/.test(words)) return this.subagent(signal);
    if (/\bsearch|\btool|\bgrep/.test(words)) return this.tool(signal);
    if (/^\/?compact/.test(words)) return this.compaction(signal);
    if (words.startsWith("/review"))
      return this.message(signal, "Reviewing: **one** change, nothing to report.");
    await this.reasoning(signal, "The user wants an overview. I should look at the layout first.");
    await this.message(signal, REPLY);
  }

  private async stream(
    signal: AbortSignal,
    item: Item & { kind: "message" | "reasoning" },
    text: string,
    pieces: RegExp = WORDS,
  ) {
    this.emit({ type: "item.started", item: { ...item, text: "", streaming: true } });
    for (const chunk of text.match(pieces) ?? []) {
      await this.pause(signal);
      this.emit({ type: "item.delta", id: item.id, field: "text", delta: chunk });
    }
    this.emit({
      type: "item.completed",
      item: { ...item, text, streaming: false, endedAt: Date.now() },
    });
  }
  private reasoning(signal: AbortSignal, text: string) {
    return this.stream(
      signal,
      {
        id: this.nextId("reasoning"),
        kind: "reasoning",
        text: "",
        streaming: true,
        startedAt: Date.now(),
      },
      text,
    );
  }
  private message(signal: AbortSignal, text: string, pieces?: RegExp) {
    return this.stream(
      signal,
      {
        id: this.nextId("message"),
        kind: "message",
        text: "",
        streaming: true,
        startedAt: Date.now(),
      },
      text,
      pieces,
    );
  }

  private async command(
    signal: AbortSignal,
    command: string,
    output: readonly string[],
    exitCode = 0,
  ) {
    const id = this.nextId("command");
    const base = { id, kind: "command" as const, command, cwd: ".", startedAt: Date.now() };
    this.emit({ type: "item.started", item: { ...base, output: "", status: "running" } });
    for (const line of output) {
      await this.pause(signal);
      this.emit({ type: "item.delta", id, field: "output", delta: `${line}\n` });
    }
    this.emit({
      type: "item.completed",
      item: {
        ...base,
        output: output.map((l) => `${l}\n`).join(""),
        exitCode,
        status: exitCode ? "error" : "done",
        endedAt: Date.now(),
      },
    });
    await this.message(signal, exitCode ? "The command failed." : "All **3** tests pass.");
  }

  private async slow(signal: AbortSignal) {
    const id = this.nextId("command");
    const base = {
      id,
      kind: "command" as const,
      command: "sleep 30",
      cwd: ".",
      startedAt: Date.now(),
    };
    this.emit({ type: "item.started", item: { ...base, output: "", status: "running" } });
    let output = "";
    try {
      for (let tick = 1; tick <= SLOW_TICKS; tick++) {
        await this.pause(signal, SLOW_TICK_FACTOR, SLOW_TICK_MIN_MS);
        const line = `waiting ${tick}\n`;
        output += line;
        this.emit({ type: "item.delta", id, field: "output", delta: line });
      }
    } catch (error: unknown) {
      this.emit({
        type: "item.completed",
        item: { ...base, output, exitCode: INTERRUPTED_EXIT, status: "error", endedAt: Date.now() },
      });
      throw error;
    }
    this.emit({
      type: "item.completed",
      item: { ...base, output, exitCode: 0, status: "done", endedAt: Date.now() },
    });
  }

  /** Opens a request and waits for its answer (or the end of the turn). */
  private ask(signal: AbortSignal, request: Request) {
    return new Promise<Response>((resolve, reject) => {
      const abort = () => {
        this.pending.delete(request.id);
        this.emit({ type: "request.resolved", id: request.id });
        reject(new Interrupted());
      };
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      this.pending.set(request.id, (response) => {
        signal.removeEventListener("abort", abort);
        resolve(response);
      });
      this.emit({ type: "request.opened", request });
    });
  }

  private async edit(signal: AbortSignal) {
    const files = [filePatch("src/greet.ts", BEFORE, AFTER)];
    await this.reasoning(signal, "The greeting lacks a comma; a template literal reads better.");
    if (this.mode === "read") {
      await this.message(
        signal,
        "I am in **read-only** mode: switch to *ask* (Shift+Tab) to let me edit `src/greet.ts`.",
      );
      return;
    }
    if (this.mode === "ask") {
      const answer = await this.ask(signal, {
        id: this.nextId("approval"),
        openedAt: Date.now(),
        kind: "approval",
        title: "Edit src/greet.ts",
        files,
        decisions: ["once", "session", "always", "deny"],
      });
      if (answer.kind !== "approval" || answer.decision === "deny") {
        this.emit({
          type: "item.completed",
          item: { id: this.nextId("edit"), kind: "file_change", files, status: "declined" },
        });
        await this.message(signal, "Understood, I left `src/greet.ts` as it was.");
        return;
      }
      if (answer.decision === "session" || answer.decision === "always") this.mode = "edits";
    }
    const id = this.nextId("edit");
    this.emit({
      type: "item.started",
      item: { id, kind: "file_change", files, status: "running", startedAt: Date.now() },
    });
    await this.pause(signal);
    this.emit({
      type: "item.completed",
      item: { id, kind: "file_change", files, status: "done", endedAt: Date.now() },
    });
    await this.message(signal, "Done: `greet` now uses a template literal.");
  }

  private async question(signal: AbortSignal) {
    const answer = await this.ask(signal, {
      id: this.nextId("question"),
      openedAt: Date.now(),
      kind: "question",
      questions: [
        {
          question: "Which test runner should I use?",
          header: "Runner",
          options: [
            { label: "bun test", description: "Already installed" },
            { label: "vitest", description: "Needs a dependency" },
            { label: "node --test", description: "Built into Node" },
          ],
        },
      ],
    });
    const chosen = answer.kind === "question" ? (answer.answers[0]?.join(", ") ?? "") : "";
    await this.message(
      signal,
      chosen ? `Going with **${chosen}**.` : "No answer: I will not pick for you.",
    );
  }

  private async planned(signal: AbortSignal) {
    const steps = ["Read src/greet.ts", "Use a template literal", "Run the tests"];
    this.emit({ type: "plan.updated", steps: steps.map((text) => ({ text, status: "pending" })) });
    await this.reasoning(signal, "Small change: read, edit, test.");
    const answer = await this.ask(signal, {
      id: this.nextId("plan"),
      openedAt: Date.now(),
      kind: "plan_review",
      plan: `## Plan\n\n1. ${steps[0]}\n2. ${steps[1]}\n3. ${steps[2]}\n\nNothing else is touched.`,
    });
    if (answer.kind !== "plan_review" || !answer.approve) {
      await this.message(
        signal,
        `Plan kept for review${answer.kind === "plan_review" && answer.feedback ? `: ${answer.feedback}` : "."}`,
      );
      return;
    }
    for (let done = 0; done <= steps.length; done++) {
      this.emit({
        type: "plan.updated",
        steps: steps.map((text, i) => ({
          text,
          status: i < done ? "completed" : i === done ? "in_progress" : "pending",
        })),
      });
      await this.pause(signal, SLOW_TICK_FACTOR);
    }
    await this.message(signal, "The plan is done.");
  }

  private async subagent(signal: AbortSignal) {
    const id = this.nextId("agent");
    const base = {
      id,
      kind: "subagent" as const,
      title: "explore captures",
      detail: "Looks for the capture code",
      startedAt: Date.now(),
    };
    this.emit({ type: "item.started", item: { ...base, tools: 0, status: "running" } });
    for (let tools = 1; tools <= SUBAGENT_TOOLS; tools++) {
      await this.pause(signal, SLOW_TICK_FACTOR);
      this.emit({ type: "item.started", item: { ...base, tools, status: "running" } });
    }
    this.emit({
      type: "item.completed",
      item: { ...base, tools: SUBAGENT_TOOLS, status: "done", endedAt: Date.now() },
    });
    await this.message(signal, "The subagent found the capture code in `src/lib/frames.ts`.");
  }

  private async tool(signal: AbortSignal) {
    const id = this.nextId("tool");
    const base = {
      id,
      kind: "tool" as const,
      name: "grep",
      title: "greet",
      input: 'pattern: "greet"',
      startedAt: Date.now(),
    };
    this.emit({ type: "item.started", item: { ...base, output: "", status: "running" } });
    await this.pause(signal);
    this.emit({
      type: "item.completed",
      item: {
        ...base,
        output: "src/greet.ts:1\ntests/greet.test.ts:3\n",
        status: "done",
        endedAt: Date.now(),
      },
    });
    await this.message(signal, "`greet` is defined once and tested once.");
  }

  private async compaction(signal: AbortSignal) {
    const id = this.nextId("compaction");
    this.emit({
      type: "item.started",
      item: { id, kind: "compaction", status: "running", startedAt: Date.now() },
    });
    await this.pause(signal, SLOW_TICK_FACTOR);
    this.emit({
      type: "item.completed",
      item: { id, kind: "compaction", status: "done", endedAt: Date.now() },
    });
  }

  async steer({ text }: UserInput) {
    this.current.items.push({ id: this.nextId("user"), kind: "user", text });
  }

  async interrupt() {
    this.turn?.abort();
  }

  async respond(request: Request, response: Response) {
    const resolve = this.pending.get(request.id);
    if (!resolve) throw new Error("The fake harness no longer waits for this answer");
    this.pending.delete(request.id);
    resolve(response);
  }

  async setModel(model: string, effort?: string) {
    const known = MODELS.find((m) => m.id === model);
    if (!known) throw new Error(`Unknown model ${model}`);
    this.model = model;
    if (effort !== undefined) {
      if (!known.efforts.includes(effort)) throw new Error(`${model} has no ${effort} effort`);
      this.effort = effort;
    }
  }

  async setMode(mode: Mode) {
    this.mode = mode;
  }

  async compact() {
    const turn = new AbortController();
    this.turn = turn;
    this.emit({ type: "turn.started" });
    void this.compaction(turn.signal).then(
      () => this.finish(turn, "completed"),
      () => this.finish(turn, "interrupted"),
    );
  }

  async newSession() {
    this.turn?.abort();
    this.current = this.fresh();
    this.announce();
  }

  async resume(id: string) {
    const found = this.sessions.get(id);
    if (!found) throw new Error(`No session ${id}`);
    this.current = found;
    this.emit({ type: "history", items: found.items });
    this.announce();
  }

  async listSessions(): Promise<readonly SessionSummary[]> {
    return [...this.sessions.values()]
      .filter((s) => s.items.length)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
  }

  async models() {
    return MODELS;
  }

  async commands() {
    return COMMANDS;
  }

  async close() {
    this.turn?.abort();
  }
}

const TEST_OUTPUT = [
  "bun test v1.4.2",
  "",
  "tests/greet.test.ts:",
  "✓ greets by name [0.12ms]",
  "✓ keeps the comma [0.04ms]",
  "✓ handles an empty name [0.03ms]",
  "",
  " 3 pass",
  " 0 fail",
];
