// Plain data shared by the Server (actions, page) and Client Components: no runtime.

export type Role = "user" | "assistant";
/** One turn of the history sent to the model. */
export type ChatMessage = { role: Role; content: string };

export type Usage = {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  /** USD. `estimated` when computed from the model's list price, not billed by the API. */
  cost?: number;
  estimated?: boolean;
};

/** What the Server streams for one reply, in order: start, text/reasoning…, usage. */
export type ChatEvent =
  | { type: "start"; model: string; provider?: string }
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "error"; message: string };

/** USD per token, as OpenRouter's `/models` lists it. */
export type Pricing = { prompt: number; completion: number };

/** What the Client may know about the Server's configuration: never the key itself. */
export type Setup = {
  model: string;
  endpoint: string;
  keyMissing: boolean;
  configError?: string;
  modelName?: string;
  pricing?: Pricing;
  contextLength?: number;
};
