import { useSyncExternalStore } from "react";
import type { ChatEvent, ChatMessage, Usage } from "./model";

// Conversations live in the Client, above the route tree: a refresh or a rebuild of the
// page keeps them, quitting loses them (like Drafts in Notes and Forge). The Server keeps
// nothing: each reply receives the whole history it answers.

export type Status = "streaming" | "done" | "stopped" | "error";
export type Message =
  | { id: number; role: "user"; content: string }
  | {
      id: number;
      role: "assistant";
      content: string;
      reasoning: string;
      status: Status;
      /** The history this reply answers: the arguments of its stream. */
      request: ChatMessage[];
      model?: string;
      usage?: Usage;
      error?: string;
      startedAt: number;
      elapsedMs?: number;
    };
export type Assistant = Extract<Message, { role: "assistant" }>;
export type Conversation = { id: number; title: string; messages: Message[] };
type State = { conversations: Conversation[]; activeId: number };

const TITLE_CHARS = 48;
let nextId = 1;
const fresh = (): Conversation => ({ id: nextId++, title: "New conversation", messages: [] });
const first = fresh();
let state: State = { conversations: [first], activeId: first.id };
const listeners = new Set<() => void>();

function set(next: State) {
  state = next;
  for (const listener of listeners) listener();
}
function updateConversation(id: number, change: (c: Conversation) => Conversation) {
  set({
    ...state,
    conversations: state.conversations.map((c) => (c.id === id ? change(c) : c)),
  });
}
function updateReply(conversationId: number, replyId: number, change: (m: Assistant) => Assistant) {
  updateConversation(conversationId, (c) => ({
    ...c,
    messages: c.messages.map((m) => (m.id === replyId && m.role === "assistant" ? change(m) : m)),
  }));
}

/** The history a new reply answers: finished turns only, errors and empty replies dropped. */
function historyOf(messages: Message[]): ChatMessage[] {
  const history: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") history.push({ role: "user", content: m.content });
    else if (m.content.trim() && m.status !== "error")
      history.push({ role: "assistant", content: m.content });
  }
  return history;
}

function startReply(conversation: Conversation, messages: Message[]): Conversation {
  const reply: Assistant = {
    id: nextId++,
    role: "assistant",
    content: "",
    reasoning: "",
    status: "streaming",
    request: historyOf(messages),
    startedAt: Date.now(),
  };
  return { ...conversation, messages: [...messages, reply] };
}

export const chats = {
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  snapshot: () => state,
  active: () => state.conversations.find((c) => c.id === state.activeId) ?? first,

  /** Opens an empty conversation, or stays on the current one if it is still empty. */
  create() {
    if (!chats.active().messages.length) return;
    const conversation = fresh();
    set({ conversations: [conversation, ...state.conversations], activeId: conversation.id });
  },
  select(delta: number) {
    const list = state.conversations;
    const at = list.findIndex((c) => c.id === state.activeId);
    const next = list[Math.max(0, Math.min(at + delta, list.length - 1))];
    if (next) set({ ...state, activeId: next.id });
  },
  selectId(id: number) {
    set({ ...state, activeId: id });
  },

  /** Appends the user's turn and a streaming reply. False while a reply is streaming. */
  send(text: string) {
    const conversation = chats.active();
    if (streamingIn(conversation)) return false;
    const turn: Message = { id: nextId++, role: "user", content: text };
    const title =
      conversation.messages.length === 0
        ? text.split("\n")[0].slice(0, TITLE_CHARS)
        : conversation.title;
    updateConversation(conversation.id, (c) => startReply({ ...c, title }, [...c.messages, turn]));
    return true;
  },
  /** Asks again for the last reply of the active conversation if it failed or was stopped. */
  retry() {
    const conversation = chats.active();
    const last = conversation.messages.at(-1);
    if (last?.role !== "assistant" || last.status === "streaming" || last.status === "done") return;
    updateConversation(conversation.id, (c) => startReply(c, c.messages.slice(0, -1)));
  },

  apply(conversationId: number, replyId: number, event: ChatEvent) {
    updateReply(conversationId, replyId, (m) => {
      if (m.status !== "streaming") return m;
      switch (event.type) {
        case "start":
          return { ...m, model: event.model };
        case "text":
          return { ...m, content: m.content + event.text };
        case "reasoning":
          return { ...m, reasoning: m.reasoning + event.text };
        case "usage":
          return { ...m, usage: event.usage };
        case "error":
          return { ...m, status: "error", error: event.message, elapsedMs: since(m) };
      }
    });
  },
  /** The stream ended: complete, or cut with a transport error. */
  finish(conversationId: number, replyId: number, error?: string) {
    updateReply(conversationId, replyId, (m) =>
      m.status !== "streaming"
        ? m
        : error
          ? { ...m, status: "error", error, elapsedMs: since(m) }
          : { ...m, status: "done", elapsedMs: since(m) },
    );
  },
  /** Stops a streaming reply; unmounting its stream aborts the request. Text so far stays. */
  stop(conversationId: number, replyId: number) {
    updateReply(conversationId, replyId, (m) =>
      m.status === "streaming" ? { ...m, status: "stopped", elapsedMs: since(m) } : m,
    );
  },
};

const since = (m: Assistant) => Date.now() - m.startedAt;
export function streamingIn(conversation: Conversation) {
  const last = conversation.messages.at(-1);
  return last?.role === "assistant" && last.status === "streaming" ? last : undefined;
}
export function totals(conversation: Conversation) {
  let tokens = 0,
    cost = 0,
    estimated = false,
    priced = false;
  for (const m of conversation.messages) {
    if (m.role !== "assistant" || !m.usage) continue;
    tokens += m.usage.promptTokens + m.usage.completionTokens;
    if (m.usage.cost !== undefined) {
      cost += m.usage.cost;
      priced = true;
      estimated ||= Boolean(m.usage.estimated);
    }
  }
  return { tokens, cost: priced ? cost : undefined, estimated };
}

export function useChats() {
  return useSyncExternalStore(chats.subscribe, chats.snapshot);
}
