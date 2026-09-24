/**
 * The live state of the capabilities a host mediates for one sandboxed origin: granted
 * (at launch, or since), denied by the user, or not decided yet (`prompt`), in which case
 * the first request asks the user, as a browser asks for a permission. Only mediated
 * capabilities change while the application runs: what the OS enforces (files, network,
 * exec) is fixed in the profile the child started with.
 */
import type { Capabilities } from "../capabilities";
import {
  capabilityOf,
  MediatedCapability,
  type CapabilityState,
  type CapabilityStates,
  type HostEvent,
  type HostRequest,
} from "../host";
import { grants, hears } from "./ipc";

/** What the user is asked: the capability, and for a secret its name. */
export type Question = { capability: MediatedCapability; detail?: string };
// A refused secret is refused by name: `secrets:<name>`.
const keyOf = (request: HostRequest) =>
  request.type === "secret" ? `secrets:${request.name}` : capabilityOf(request);

/** `caps` with `request`'s capability granted too. */
function withGrant(caps: Capabilities, request: HostRequest): Capabilities {
  switch (request.type) {
    case "clipboard.read":
      return { ...caps, clipboard: { ...caps.clipboard, read: true } };
    case "clipboard.write":
      return { ...caps, clipboard: { ...caps.clipboard, write: true } };
    case "notify":
      return { ...caps, notify: true };
    case "open-url":
      return { ...caps, openUrl: true };
    case "secret":
      return { ...caps, secrets: [...caps.secrets, request.name] };
    case "tabs.post":
      return { ...caps, tabsMessage: true };
  }
}
const isGranted = (caps: Capabilities, capability: MediatedCapability) =>
  ({
    "clipboard.read": caps.clipboard.read,
    "clipboard.write": caps.clipboard.write,
    notify: caps.notify,
    "open-url": caps.openUrl,
    secrets: caps.secrets.length > 0,
    "tabs.message": caps.tabsMessage,
    "input.global": caps.inputGlobal,
  })[capability];

/** The refusals `granted` does not override (a flag grants what was refused before). */
export const stillDenied = (granted: Capabilities, denied: readonly string[]) =>
  denied.filter((key) => {
    if (key.startsWith("secrets:")) return !granted.secrets.includes(key.slice("secrets:".length));
    const capability = MediatedCapability.safeParse(key);
    return capability.success && !isGranted(granted, capability.data);
  });

export type Permissions = ReturnType<typeof createPermissions>;
export function createPermissions(options: {
  granted: Capabilities;
  /** Refused by the user: capability names, `secrets:<name>`. */
  denied?: readonly string[];
  /** Asks the user; without it, anything undecided is refused. */
  ask?: (question: Question) => Promise<boolean>;
  /** A decision the user made: to remember, and to tell the application. */
  onChange?: (change: { capability: MediatedCapability; state: CapabilityState }) => void;
}) {
  let granted = options.granted;
  const denied = new Set(options.denied ?? []);
  // One question per capability at a time: concurrent requests share its answer.
  const asking = new Map<string, Promise<boolean>>();
  const state = (capability: MediatedCapability): CapabilityState => {
    if (isGranted(granted, capability)) return "granted";
    const refused =
      capability === "secrets"
        ? [...denied].some((key) => key.startsWith("secrets:"))
        : denied.has(capability);
    return refused ? "denied" : "prompt";
  };
  return {
    granted: () => granted,
    denied: () => [...denied],
    state,
    states: (): CapabilityStates =>
      Object.fromEntries(MediatedCapability.options.map((c) => [c, state(c)])),
    hears: (event: HostEvent) => event.type === "capability" || hears(granted, event),
    /** Whether `request` may be performed, asking the user when it is undecided. */
    async allow(request: HostRequest): Promise<boolean> {
      if (grants(granted, request)) return true;
      const key = keyOf(request);
      if (denied.has(key) || !options.ask) return false;
      const pending = asking.get(key);
      if (pending) return pending;
      const capability = capabilityOf(request);
      const before = state(capability);
      const answer = options
        .ask({ capability, ...(request.type === "secret" && { detail: request.name }) })
        .then((yes) => {
          if (yes) granted = withGrant(granted, request);
          else denied.add(key);
          const after = state(capability);
          if (after !== before) options.onChange?.({ capability, state: after });
          return yes;
        })
        .finally(() => asking.delete(key));
      asking.set(key, answer);
      return answer;
    },
  };
}
