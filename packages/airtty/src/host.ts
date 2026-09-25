/**
 * `host` (in `airtty/client`): what an application asks of whoever hosts it, for the
 * capabilities the OS cannot grant piecemeal (docs/EMBEDDING.md, section 5): the
 * clipboard, notifications, opening a URL, secrets, messages between tabs, keys typed
 * outside the application.
 *
 * Each bundle evaluation gets its own `host`, bound with its Server Functions to the
 * Application it created (`airtty:actions`, src/build.ts): two panes of one runtime ask
 * with their own origin and their own capabilities. The Application's `HostChannel`
 * decides who answers:
 *
 * - by default the Client itself, with the user's rights (a standalone Client, or an
 *   `inline` pane: nothing is enforced there, docs/EMBEDDING.md decision 5);
 * - in the `sandbox` mode, the host process over IPC (src/sandbox/ipc.ts), which checks
 *   the capability the user granted and refuses with `CapabilityDenied` otherwise.
 */
import * as z from "zod/mini";
import type { Application } from "./client";
import { performDirectly } from "./host-direct";

export { performDirectly } from "./host-direct";

// Bounds on what an application may send: the host copies, shows or stores it.
const MAX_TEXT_BYTES = 1_048_576;
const MAX_TITLE = 256;
const MAX_BODY = 4096;
const MAX_URL = 2048;
const MAX_MESSAGE_BYTES = 65_536;

/** A secret's name: a keychain account, never a path. */
export const SecretName = z.string().check(z.regex(/^[\w.-]{1,64}$/));
const OpenableUrl = z.string().check(
  z.maxLength(MAX_URL),
  z.refine((url) => /^https?:\/\//i.test(url) && URL.canParse(url), "an http(s) URL"),
);
const Message = z
  .unknown()
  .check(
    z.refine(
      (value) => JSON.stringify(value ?? null).length <= MAX_MESSAGE_BYTES,
      `a JSON value of at most ${MAX_MESSAGE_BYTES} bytes`,
    ),
  );

/** What an application asks; validated wherever it crosses a process boundary. */
export const HostRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("clipboard.read") }),
  z.object({
    type: z.literal("clipboard.write"),
    text: z.string().check(z.maxLength(MAX_TEXT_BYTES)),
  }),
  z.object({
    type: z.literal("notify"),
    title: z.string().check(z.maxLength(MAX_TITLE)),
    body: z.optional(z.string().check(z.maxLength(MAX_BODY))),
  }),
  z.object({ type: z.literal("open-url"), url: OpenableUrl }),
  z.object({ type: z.literal("secret"), name: SecretName }),
  z.object({ type: z.literal("tabs.post"), message: Message }),
]);
export type HostRequest = z.infer<typeof HostRequest>;

/** A key typed outside the application (`input.global`), as the host saw it. */
export const GlobalKey = z.object({
  name: z.string().check(z.maxLength(MAX_TITLE)),
  sequence: z.string().check(z.maxLength(MAX_TITLE)),
  ctrl: z.boolean(),
  meta: z.boolean(),
  shift: z.boolean(),
});
export type GlobalKey = z.infer<typeof GlobalKey>;
/** The capabilities a host mediates, as `airtty.capabilities` names them to the user. */
export const MediatedCapability = z.enum([
  "clipboard.read",
  "clipboard.write",
  "notify",
  "open-url",
  "secrets",
  "tabs.message",
  "input.global",
]);
export type MediatedCapability = z.infer<typeof MediatedCapability>;
/**
 * Where a capability stands for this application: `granted`, `denied` by the user, or
 * `prompt`: not decided, the host asks the user at the first request. Outside the
 * sandbox (a standalone Client, an inline pane) everything is `granted`.
 */
export const CapabilityState = z.enum(["granted", "denied", "prompt"]);
export type CapabilityState = z.infer<typeof CapabilityState>;
export const CapabilityStates = z.partialRecord(MediatedCapability, CapabilityState);
export type CapabilityStates = z.infer<typeof CapabilityStates>;
/** What the host sends unasked. */
export const HostEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tabs.message"), from: z.string(), message: Message }),
  z.object({ type: z.literal("input.key"), key: GlobalKey }),
  z.object({
    type: z.literal("capability"),
    capability: MediatedCapability,
    state: CapabilityState,
  }),
]);
export type HostEvent = z.infer<typeof HostEvent>;

export const capabilityOf = (request: HostRequest): MediatedCapability =>
  request.type === "secret"
    ? "secrets"
    : request.type === "tabs.post"
      ? "tabs.message"
      : request.type;

/** The host refused: the user did not grant `capability` to this origin. */
export class CapabilityDenied extends Error {
  readonly capability: MediatedCapability;
  constructor(capability: MediatedCapability, detail?: string) {
    super(`Capability ${capability} not granted${detail ? ` (${detail})` : ""}`);
    this.name = "CapabilityDenied";
    this.capability = capability;
  }
}

/** Who answers an Application's requests: the Client itself, or its host over IPC. */
export type HostChannel = {
  request(request: HostRequest): Promise<unknown>;
  /** Where `capability` stands now; a `capability` event says when it changes. */
  state(capability: MediatedCapability): CapabilityState;
  /** Events the host sends; returns the unsubscription. */
  listen(listener: (event: HostEvent) => void): () => void;
};

/** The channel of a Client that answers itself: no host, so no events either. */
export function directChannel(origin: string): HostChannel {
  const perform = performDirectly(origin);
  return {
    request: async (request) => perform(HostRequest.parse(request)),
    // Nothing is enforced here: the Client has the user's rights.
    state: () => "granted",
    listen: () => () => {},
  };
}

export type Host = {
  clipboard: {
    /** The clipboard's text (`clipboard.read`). */
    read(): Promise<string>;
    /** Replaces the clipboard's text (`clipboard.write`). */
    write(text: string): Promise<void>;
  };
  /** A desktop notification (`notify`). */
  notify(notification: { title: string; body?: string }): Promise<void>;
  /** Opens an http(s) URL in the user's browser (`open-url`). */
  openUrl(url: string): Promise<void>;
  /** A secret the user stored for this origin, `undefined` when absent (`secrets`). */
  secret(name: string): Promise<string | undefined>;
  tabs: {
    /** Sends a JSON value to the host's other tabs that accept messages (`tabs.message`). */
    post(message: unknown): Promise<void>;
    /** Messages other tabs posted, with their origin; returns the unsubscription. */
    onMessage(listener: (message: unknown, from: string) => void): () => void;
  };
  input: {
    /** Keys typed while another pane has the focus (`input.global`). */
    onGlobalKey(listener: (key: GlobalKey) => void): () => void;
  };
};

const unbound = (): HostChannel => {
  const fail = () =>
    Promise.reject(new Error("host is bound per bundle to its Application; none is mounted"));
  return { request: fail, state: () => "granted", listen: () => () => {} };
};

/** The `host` of one bundle evaluation, asking through `application()`'s channel. */
export function createHost(application: () => Application | undefined): Host {
  const channel = () => application()?.host ?? unbound();
  const ask = (request: HostRequest) => channel().request(request);
  return {
    clipboard: {
      read: async () => String(await ask({ type: "clipboard.read" })),
      write: async (text) => void (await ask({ type: "clipboard.write", text })),
    },
    notify: async ({ title, body }) => void (await ask({ type: "notify", title, body })),
    openUrl: async (url) => void (await ask({ type: "open-url", url })),
    secret: async (name) => {
      const value = await ask({ type: "secret", name });
      return typeof value === "string" ? value : undefined;
    },
    tabs: {
      post: async (message) => void (await ask({ type: "tabs.post", message })),
      onMessage: (listener) =>
        channel().listen((event) => {
          if (event.type === "tabs.message") listener(event.message, event.from);
        }),
    },
    input: {
      onGlobalKey: (listener) =>
        channel().listen((event) => {
          if (event.type === "input.key") listener(event.key);
        }),
    },
  };
}
