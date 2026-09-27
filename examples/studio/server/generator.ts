/**
 * studio's scripted harness: the `fake` of coder, except that it really writes the
 * project, as a coding agent would, from the scenarios of server/scenarios.ts. A prompt
 * picks a scenario by its words; each correction studio sends (a message starting with
 * STUDIO_PREFIX) plays the scenario's next turn. No process, no model, no quota: tests,
 * demos and a first look at studio run on it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { filePatch } from "@airtty/harness/diff";
import type {
  Harness,
  HarnessContext,
  StartOptions,
  UserInput,
} from "@airtty/harness/adapters/types";
import type { Capabilities, Item, Request, Response } from "@airtty/harness/model";
import { SCENARIOS, type Scenario } from "./scenarios";

/** How studio's own messages to the harness begin (server/studio.ts). */
export const STUDIO_PREFIX = "[studio]";
const DEFAULT_DELAY_MS = 40;
const Environment = z.object({
  // Pause between the steps of a turn; tests set it to 1.
  STUDIO_FAKE_DELAY_MS: z.coerce.number().int().min(0).default(DEFAULT_DELAY_MS),
});
const CAPABILITIES: Capabilities = {
  steer: false,
  models: false,
  effort: false,
  modes: ["edits"],
  compact: false,
  resume: false,
  newSession: false,
  planMode: false,
  images: false,
};
const HELP = `I am studio's scripted generator: no model runs, I write what these prompts ask for.

${SCENARIOS.map((s) => `- ${s.prompt}`).join("\n")}`;

export class Generator implements Harness {
  readonly id = "fake" as const;
  readonly capabilities = CAPABILITIES;
  private readonly context: HarnessContext;
  private readonly delay: number;
  private cwd = "";
  private scenario: Scenario | undefined;
  private turn = 0;
  private next = 0;
  private interrupted = false;
  private readonly pending = new Map<string, (response: Response) => void>();

  constructor(context: HarnessContext) {
    this.context = context;
    this.delay = Environment.parse(context.env).STUDIO_FAKE_DELAY_MS;
  }
  private id_(prefix: string) {
    return `${prefix}-${++this.next}`;
  }
  private pause() {
    return this.delay ? Bun.sleep(this.delay) : Promise.resolve();
  }

  async start(options: StartOptions) {
    this.cwd = options.cwd;
    this.context.emit({
      type: "info.updated",
      info: { sessionId: crypto.randomUUID(), mode: "edits", model: "scripted" },
    });
  }

  async send({ text }: UserInput) {
    this.interrupted = false;
    void this.play(text).then(
      (status) => this.context.emit({ type: "turn.completed", status }),
      (error: unknown) =>
        this.context.emit({
          type: "turn.completed",
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        }),
    );
  }

  private async play(text: string): Promise<"completed" | "interrupted"> {
    this.context.emit({ type: "turn.started" });
    const correction = text.startsWith(STUDIO_PREFIX);
    if (correction) this.turn++;
    else {
      this.scenario = SCENARIOS.find((s) => s.match.test(text));
      this.turn = 0;
    }
    const scenario = this.scenario;
    const files = scenario?.turns[this.turn];
    if (!scenario || !files) {
      await this.say(correction ? "I have no further correction for this: over to you." : HELP);
      return "completed";
    }
    await this.pause();
    await this.say(correction ? "Fixing what studio reported." : scenario.reply);
    if (scenario.command && !correction && !(await this.run(scenario.command))) {
      await this.say("The command was refused: studio checks the app itself.");
    }
    if (this.interrupted) return "interrupted";
    await this.pause();
    const patches = Object.entries(files).map(([path, after]) => {
      const file = join(this.cwd, path);
      const before = existsSync(file) ? readFileSync(file, "utf8") : "";
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, after);
      return filePatch(path, before, after);
    });
    const item: Item = {
      id: this.id_("edit"),
      kind: "file_change",
      files: patches,
      status: "done",
      startedAt: Date.now(),
      endedAt: Date.now(),
    };
    this.context.emit({ type: "item.completed", item });
    await this.say(`Wrote ${patches.map((p) => p.path).join(", ")}.`);
    return "completed";
  }

  private async say(text: string) {
    this.context.emit({
      type: "item.completed",
      item: { id: this.id_("message"), kind: "message", text, streaming: false },
    });
    await this.pause();
  }

  /** Asks to run `command`, as a real harness would; true when allowed. */
  private run(command: string): Promise<boolean> {
    const request: Request = {
      id: this.id_("approval"),
      openedAt: Date.now(),
      kind: "approval",
      title: `Run ${command}`,
      command,
      decisions: ["once", "deny"],
    };
    return new Promise((resolve) => {
      this.pending.set(request.id, (response) =>
        resolve(response.kind === "approval" && response.decision !== "deny"),
      );
      this.context.emit({ type: "request.opened", request });
    });
  }

  async respond(request: Request, response: Response) {
    const resolve = this.pending.get(request.id);
    this.pending.delete(request.id);
    this.context.emit({ type: "request.resolved", id: request.id });
    resolve?.(response);
  }
  async interrupt() {
    this.interrupted = true;
    for (const [id, resolve] of this.pending) {
      this.pending.delete(id);
      this.context.emit({ type: "request.resolved", id });
      resolve({ kind: "cancel" });
    }
  }
  async steer() {}
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
