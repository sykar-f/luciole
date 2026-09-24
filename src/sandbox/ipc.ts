/**
 * The channel between the host and a sandboxed child, for the capabilities the host
 * mediates (src/host.ts): Bun's IPC, a socketpair the child inherits as a file descriptor,
 * one JSON value per message. Never the terminal stream: an OSC 52 or OSC 9 a sandboxed
 * application writes is only drawn, or dropped, by the VT widget.
 *
 * The host trusts nothing that arrives: every message is validated with Zod, then the
 * request is checked against what the user granted the origin (asking the user when it
 * is undecided, src/sandbox/permissions.ts), and only then performed.
 */
import * as z from "zod/mini";
import type { Capabilities } from "../capabilities";
import { messageOf } from "../guards";
import {
  CapabilityDenied,
  capabilityOf,
  HostEvent,
  HostRequest,
  MediatedCapability,
  type CapabilityStates,
  type HostChannel,
} from "../host";

const RequestId = z.number().check(z.int(), z.gte(0));
/** Child → host. The request itself is validated apart, to answer a precise refusal. */
const ChildMessage = z.object({ kind: z.literal("request"), id: RequestId, request: z.unknown() });
/** Host → child. */
export const HostMessage = z.union([
  z.object({ kind: z.literal("reply"), id: RequestId, ok: z.literal(true), value: z.unknown() }),
  z.object({
    kind: z.literal("reply"),
    id: RequestId,
    ok: z.literal(false),
    error: z.string(),
    denied: z.optional(MediatedCapability),
  }),
  z.object({ kind: z.literal("event"), event: HostEvent }),
]);
export type HostMessage = z.infer<typeof HostMessage>;

/** Whether `caps` covers `request`: a secret is granted by name. */
export function grants(caps: Capabilities, request: HostRequest): boolean {
  switch (request.type) {
    case "clipboard.read":
      return caps.clipboard.read;
    case "clipboard.write":
      return caps.clipboard.write;
    case "notify":
      return caps.notify;
    case "open-url":
      return caps.openUrl;
    case "secret":
      return caps.secrets.includes(request.name);
    case "tabs.post":
      return caps.tabsMessage;
  }
}
/** Whether `caps` lets the child hear `event`; its capabilities' changes, always. */
export const hears = (caps: Capabilities, event: HostEvent) =>
  event.type === "capability" ||
  (event.type === "tabs.message" ? caps.tabsMessage : caps.inputGlobal);

/**
 * The host's answer to one message of the child: `undefined` when it is not even a
 * request (nothing to answer), a refusal when the request is malformed or not granted.
 */
export async function answer(
  received: unknown,
  allow: (request: HostRequest) => Promise<boolean>,
  perform: (request: HostRequest) => Promise<unknown>,
): Promise<HostMessage | undefined> {
  const message = ChildMessage.safeParse(received);
  if (!message.success) return undefined;
  const { id } = message.data;
  const request = HostRequest.safeParse(message.data.request);
  if (!request.success)
    return {
      kind: "reply",
      id,
      ok: false,
      error: `Invalid request: ${z.prettifyError(request.error)}`,
    };
  if (!(await allow(request.data))) {
    const denied = capabilityOf(request.data);
    return { kind: "reply", id, ok: false, error: new CapabilityDenied(denied).message, denied };
  }
  try {
    return { kind: "reply", id, ok: true, value: (await perform(request.data)) ?? null };
  } catch (error: unknown) {
    return { kind: "reply", id, ok: false, error: messageOf(error) };
  }
}

type Port = {
  send(message: unknown): void;
  on(listener: (message: unknown) => void): void;
};
const processPort = (): Port | undefined => {
  const send = process.send?.bind(process);
  if (!send) return undefined;
  return {
    send: (message) => void send(message),
    on: (listener) => void process.on("message", listener),
  };
};

/**
 * The sandboxed side: requests over the inherited channel, events from the host, and the
 * state of each capability, `initial` from the host at start, then as the host reports.
 */
export function ipcChannel(
  initial: CapabilityStates,
  port: Port | undefined = processPort(),
): HostChannel {
  if (!port) throw new Error("No IPC channel to the host: the child must be started by it");
  let next = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const listeners = new Set<(event: HostEvent) => void>();
  const states = { ...initial };
  port.on((received) => {
    const message = HostMessage.safeParse(received);
    if (!message.success) return;
    const data = message.data;
    if (data.kind === "event") {
      if (data.event.type === "capability") states[data.event.capability] = data.event.state;
      for (const listener of listeners) listener(data.event);
      return;
    }
    const waiting = pending.get(data.id);
    pending.delete(data.id);
    if (!waiting) return;
    if (data.ok) waiting.resolve(data.value ?? undefined);
    else waiting.reject(data.denied ? new CapabilityDenied(data.denied) : new Error(data.error));
  });
  return {
    request: (request) =>
      new Promise((resolve, reject) => {
        const id = next++;
        pending.set(id, { resolve, reject });
        port.send({ kind: "request", id, request });
      }),
    // Not reported: nothing granted, the host asks at the first request.
    state: (capability) => states[capability] ?? "prompt",
    listen: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
