import "server-only";
import type { Block, Usage } from "../components/model";
import { textOf, type AssistantEvent, type Message, type Part } from "./protocol";

// Tool outputs are kept head and tail: a `cat` of a large file must not grow every
// snapshot sent to the Client.
const OUTPUT_KEPT = 12_000;
const HALF = OUTPUT_KEPT / 2;
// The transcript keeps its most recent blocks; older ones remain in pi's session file.
const BLOCKS_KEPT = 400;

type Tool = Extract<Block, { kind: "tool" }>;

function clip(text: string): { output: string; elided: number } {
  if (text.length <= OUTPUT_KEPT) return { output: text, elided: 0 };
  return {
    output: `${text.slice(0, HALF)}\n…\n${text.slice(-HALF)}`,
    elided: text.length - OUTPUT_KEPT,
  };
}

/**
 * The conversation as the UI shows it, built from pi's streamed events (live) or from its
 * message list (after a restart). Blocks are replaced, never mutated: a snapshot handed to
 * a subscriber stays as it was sent.
 */
export class Transcript {
  blocks: Block[] = [];
  usage: Usage = { input: 0, output: 0, cost: 0 };
  // Blocks of the assistant message being streamed, by pi's `contentIndex`.
  private message = 0;
  private notices = 0;

  reset() {
    this.blocks = [];
    this.usage = { input: 0, output: 0, cost: 0 };
  }

  private push(block: Block) {
    this.blocks = [...this.blocks, block].slice(-BLOCKS_KEPT);
  }
  private update(id: string, change: (block: Block) => Block) {
    this.blocks = this.blocks.map((block) => (block.id === id ? change(block) : block));
  }
  private updateTool(id: string, change: (tool: Tool) => Tool) {
    this.update(id, (block) => (block.kind === "tool" ? change(block) : block));
  }
  private partId(index: number) {
    return `m${this.message}:${index}`;
  }

  notice(level: "info" | "error", text: string) {
    this.push({ kind: "notice", id: `n${++this.notices}`, level, text });
  }

  user(content: string | Part[]) {
    this.push({ kind: "user", id: `u${++this.message}`, text: textOf(content) });
  }

  assistantStart() {
    this.message++;
  }

  assistantEvent(event: AssistantEvent) {
    const id = this.partId(event.contentIndex);
    switch (event.type) {
      case "text_start":
        return this.push({ kind: "text", id, text: "", streaming: true });
      case "thinking_start":
        return this.push({ kind: "thinking", id, text: "", streaming: true });
      case "text_delta":
      case "thinking_delta":
        return this.update(id, (block) =>
          block.kind === "text" || block.kind === "thinking"
            ? { ...block, text: block.text + (event.delta ?? "") }
            : block,
        );
      case "text_end":
      case "thinking_end":
        return this.update(id, (block) =>
          block.kind === "text" || block.kind === "thinking"
            ? { ...block, text: event.content ?? block.text, streaming: false }
            : block,
        );
      case "toolcall_start":
        return this.push({
          kind: "tool",
          id: event.id ?? id,
          name: event.toolName ?? "tool",
          args: {},
          argsText: "",
          status: "streaming",
          output: "",
          elided: 0,
        });
      case "toolcall_delta": {
        const tool = this.blocks.findLast((block) => block.kind === "tool");
        if (tool)
          this.updateTool(tool.id, (t) => ({ ...t, argsText: t.argsText + (event.delta ?? "") }));
        return;
      }
      case "toolcall_end": {
        const call = event.toolCall;
        if (call)
          this.updateTool(call.id, (t) => ({ ...t, args: call.arguments, status: "pending" }));
        return;
      }
    }
  }

  /** The final assistant message: authoritative for text, usage and errors. */
  assistantEnd(
    message: Extract<Message, { role: "assistant" }>,
    options: { aborting: boolean } = { aborting: false },
  ) {
    // Blocks still marked streaming (an abort mid-sentence) are finished as they are.
    this.blocks = this.blocks.map((block) =>
      (block.kind === "text" || block.kind === "thinking") && block.streaming
        ? { ...block, streaming: false }
        : block,
    );
    if (message.usage) {
      this.usage = {
        input: this.usage.input + message.usage.input,
        output: this.usage.output + message.usage.output,
        cost: this.usage.cost + message.usage.cost.total,
      };
    }
    // An abort that lands during a tool call ends the message with an error, not
    // `aborted`: the user asked for it, so it reads the same.
    const interrupted =
      message.stopReason === "aborted" || (options.aborting && message.stopReason === "error");
    if (interrupted) this.notice("info", "Interrupted");
    else if (message.stopReason === "error")
      this.notice("error", message.errorMessage ?? "Model error");
  }

  toolStart(id: string, name: string, args: Record<string, unknown>) {
    if (!this.blocks.some((block) => block.id === id))
      this.push({
        kind: "tool",
        id,
        name,
        args,
        argsText: "",
        status: "pending",
        output: "",
        elided: 0,
      });
    this.updateTool(id, (t) => ({ ...t, args, status: "running", startedAt: Date.now() }));
  }
  toolOutput(id: string, text: string) {
    this.updateTool(id, (t) => ({ ...t, ...clip(text) }));
  }
  toolEnd(id: string, text: string, isError: boolean) {
    this.updateTool(id, (t) => ({
      ...t,
      ...clip(text),
      status: isError ? "error" : "done",
      endedAt: Date.now(),
    }));
  }
  /** Calls left unfinished by an abort or a crash. */
  settle() {
    this.blocks = this.blocks.map((block) =>
      block.kind === "tool" && block.status !== "done" && block.status !== "error"
        ? { ...block, status: "error", output: block.output || "Not completed" }
        : block,
    );
  }

  /** Rebuilds the transcript from pi's message list (a restarted Server, a resumed session). */
  load(messages: readonly Message[]) {
    this.reset();
    for (const message of messages) {
      if (message.role === "user" && "content" in message) this.user(message.content);
      else if (message.role === "assistant" && "stopReason" in message) {
        this.assistantStart();
        message.content.forEach((part, index) => {
          const id = this.partId(index);
          if (part.type === "text" && "text" in part)
            this.push({ kind: "text", id, text: part.text, streaming: false });
          else if (part.type === "thinking" && "thinking" in part)
            this.push({ kind: "thinking", id, text: part.thinking, streaming: false });
          else if (part.type === "toolCall" && "arguments" in part)
            this.push({
              kind: "tool",
              id: part.id,
              name: part.name,
              args: part.arguments,
              argsText: "",
              status: "pending",
              output: "",
              elided: 0,
            });
        });
        this.assistantEnd(message);
      } else if (message.role === "toolResult" && "toolCallId" in message)
        this.toolEnd(message.toolCallId, textOf(message.content), message.isError);
    }
    this.settle();
  }
}
