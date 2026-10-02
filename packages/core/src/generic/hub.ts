/**
 * The generic Client's side of `host` (src/host.ts) for its tabs: messages between tabs
 * (`tabs.message`) and keys typed while another tab has the focus (`input.global`). An
 * inline tab is answered in process, with everything allowed (docs/EMBEDDING.md, decision
 * 5); a sandboxed tab through its IPC channel, where the host checks its grants
 * (src/sandbox/ipc.ts) before and after this hub.
 */
import type { KeyEvent } from "@opentui/core";
import { performDirectly, type HostChannel, type HostEvent, type HostRequest } from "../host";

type Member = {
  origin: string;
  /** Whether the tab may hear `event`; inline, everything. */
  hears: (event: HostEvent) => boolean;
  deliver(event: HostEvent): void;
};

export function createHub() {
  const members = new Map<number, Member>();
  let active: number | undefined;
  const send = (event: HostEvent, except: number | undefined) => {
    for (const [id, member] of members)
      if (id !== except && member.hears(event)) member.deliver(event);
  };
  return {
    /** Adds a tab; returns its removal. */
    join(id: number, member: Member) {
      members.set(id, member);
      return () => void members.delete(id);
    },
    focus(id: number | undefined) {
      active = id;
    },
    /** Performs what a tab asked (granted already): `tabs.post` here, the rest directly. */
    perform(id: number, origin: string) {
      const direct = performDirectly(origin);
      return async (request: HostRequest): Promise<unknown> => {
        if (request.type !== "tabs.post") return direct(request);
        send({ type: "tabs.message", from: origin, message: request.message }, id);
        return undefined;
      };
    },
    /** A key the host saw: the tabs without the focus that may hear it get it. */
    key(event: KeyEvent) {
      send(
        {
          type: "input.key",
          key: {
            name: event.name,
            sequence: event.sequence,
            ctrl: event.ctrl,
            meta: event.meta,
            shift: event.shift,
          },
        },
        active,
      );
    },
  };
}
export type Hub = ReturnType<typeof createHub>;

/** The `host` channel of an inline tab: in process, everything allowed. */
export function inlineChannel(
  hub: Hub,
  id: number,
  origin: string,
): HostChannel & { close(): void } {
  const listeners = new Set<(event: HostEvent) => void>();
  const leave = hub.join(id, {
    origin,
    hears: () => true,
    deliver: (event) => {
      for (const listener of listeners) listener(event);
    },
  });
  const perform = hub.perform(id, origin);
  return {
    request: perform,
    // Inline: nothing is enforced, everything is allowed (decision 5).
    state: () => "granted",
    listen: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: leave,
  };
}
