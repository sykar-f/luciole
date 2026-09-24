// What the Server tells the Client about the agent: plain data, shared by both sides.

export type ToolStatus = "streaming" | "pending" | "running" | "done" | "error";

export type Block =
  | { kind: "user"; id: string; text: string }
  | { kind: "text"; id: string; text: string; streaming: boolean }
  | { kind: "thinking"; id: string; text: string; streaming: boolean }
  | {
      kind: "tool";
      id: string;
      name: string;
      /** Parsed arguments once the call is complete; `{}` while they stream. */
      args: Record<string, unknown>;
      /** Raw JSON of the arguments while the model is still writing them. */
      argsText: string;
      status: ToolStatus;
      output: string;
      /** Characters dropped from the middle of a long output. */
      elided: number;
      startedAt?: number;
      endedAt?: number;
    }
  | { kind: "notice"; id: string; level: "info" | "error"; text: string };

/**
 * `starting`: the pi process boots. `idle`: waiting for a prompt. `running`: a prompt is
 * being worked on. `aborting`: an abort was sent, pi has not settled yet. `stopped`: the
 * process exited; the next prompt starts it again.
 */
export type AgentState = "starting" | "idle" | "running" | "aborting" | "stopped";

export type Usage = { input: number; output: number; cost: number };

export type Snapshot = {
  version: number;
  state: AgentState;
  model: string;
  thinking: string;
  cwd: string;
  sessionId: string | null;
  blocks: Block[];
  /** Steering messages typed while running, not yet delivered to the model. */
  queued: string[];
  usage: Usage;
  error: string | null;
};

export type SendResult = { ok: true } | { ok: false; error: string };
