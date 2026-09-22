/** @jsxImportSource @opentui/react */
import React, {
  Component,
  Suspense,
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
} from "react";
import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import {
  decode,
  encodeReply,
  installResolver,
  createServerReference,
  type ModuleResolver,
} from "./flight/client";
import { DraftStore, type Note, type SaveResult, type Snapshot } from "./draft";
export type { Note, SaveResult, Snapshot } from "./draft";
export class TransportError extends Error {}
export class BuildMismatch extends TransportError {}
export type ApplicationOptions = {
  url: string;
  buildId: string;
  resolveModule: ModuleResolver;
  token?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};
let current: Application;
export function actionReference(id: string) {
  return createServerReference(id, (key: string, args: unknown[]) => {
    if (!current) throw new Error("Application not mounted");
    return current.callServer(key, args);
  });
}
export class Application {
  readonly drafts = new DraftStore();
  path = "/";
  status = "Connecting";
  tree: any = null;
  generation = 0;
  revision = 0;
  error = "";
  private listeners = new Set<() => void>();
  constructor(readonly options: ApplicationOptions) {
    installResolver(options.resolveModule);
    // oxlint-disable-next-line typescript/no-this-alias -- Register the single application instance used by generated action proxies.
    current = this;
  }
  subscribe = (f: () => void) => {
    this.listeners.add(f);
    return () => {
      this.listeners.delete(f);
    };
  };
  snapshot = () => this.revision;
  notify = () => {
    this.revision++;
    for (const f of this.listeners) f();
  };
  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("x-terminal-build", this.options.buildId);
    if (this.options.token) headers.set("authorization", `Bearer ${this.options.token}`);
    try {
      const response = await (this.options.fetch ?? fetch)(new URL(path, this.options.url), {
        ...init,
        headers,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10000),
      });
      if (response.status === 409) throw new BuildMismatch(await response.text());
      if (!response.ok)
        throw new TransportError(`HTTP ${response.status}: ${await response.text()}`);
      return response;
    } catch (e) {
      throw e instanceof TransportError
        ? e
        : new TransportError(e instanceof Error ? e.message : String(e));
    }
  }
  async navigate(path: string) {
    if (!path.startsWith("/") || path.startsWith("//"))
      throw new Error("Expected application route");
    const generation = ++this.generation;
    try {
      const response = await this.request(`/render?path=${encodeURIComponent(path)}`);
      const pending = decode(response.body!, this.callServer);
      // Wait only for the root model. Nested Flight promises remain progressive Suspense content.
      const tree = await pending;
      if (generation !== this.generation) return;
      this.tree = tree;
      this.path = path;
      this.status = "Connected";
      this.error = "";
      this.notify();
    } catch (e) {
      if (generation !== this.generation) return;
      this.status = e instanceof BuildMismatch ? "Incompatible build" : "Disconnected";
      this.error = (e as Error).message;
      this.notify();
    }
  }
  refresh = () => this.navigate(this.path);
  callServer = async (id: string, args: unknown[]) => {
    const callId = crypto.randomUUID(),
      generation = this.generation;
    try {
      const response = await this.request("/action", {
        method: "POST",
        headers: { "x-terminal-action": id, "x-terminal-call": callId },
        body: await encodeReply(args),
      });
      const envelope = await decode(response.body!, this.callServer);
      if (envelope.kind !== "result" || envelope.callId !== callId)
        throw new TransportError("Invalid action response");
      this.status = "Connected";
      this.notify();
      if (envelope.refresh && generation === this.generation) void this.refresh(); // refresh failures never reject a committed business result
      return envelope.value;
    } catch (e) {
      this.status = e instanceof BuildMismatch ? "Incompatible build" : "Disconnected";
      this.error = (e as Error).message;
      this.notify();
      throw e;
    }
  };
}
const Runtime = createContext<Application | null>(null);
export function useApplication() {
  const app = useContext(Runtime);
  if (!app) throw new Error("Missing terminal shell");
  return app;
}
export function useNavigation() {
  const app = useApplication();
  return {
    navigate: (path: string) => app.navigate(path),
    refresh: app.refresh,
  };
}
export function useDraft(note: Note) {
  const app = useApplication();
  useSyncExternalStore(app.drafts.subscribe, app.drafts.snapshot);
  const draft = app.drafts.get(note);
  useEffect(() => {
    draft.receive(note);
    app.drafts.changed();
  }, [app.drafts, draft, note]);
  return {
    draft,
    edit: (value: string) => {
      draft.edit(value);
      app.drafts.changed();
    },
    discard: () => {
      draft.discard(note);
      app.drafts.changed();
    },
    save: async (action: (s: Snapshot) => Promise<SaveResult>) => {
      if (draft.pending) return;
      const snapshot = draft.begin();
      app.drafts.changed();
      try {
        draft.confirm(await action(snapshot));
      } catch {
        draft.markUnknown();
      }
      app.drafts.changed();
    },
    recover: async (action: (id: string) => Promise<SaveResult | null>) => {
      if (!draft.pending || !draft.unknown) return;
      try {
        const result = await action(draft.pending.operationId);
        if (result) draft.confirm(result);
        else draft.markUnresolved();
      } catch {
        draft.markUnknown();
      }
      app.drafts.changed();
    },
  };
}
class RenderErrorBoundary extends Component<
  { children: React.ReactNode; reset: number },
  { error: boolean; reset: number }
> {
  state = { error: false, reset: this.props.reset };
  static getDerivedStateFromError() {
    return { error: true };
  }
  static getDerivedStateFromProps(props: { reset: number }, state: { reset: number }) {
    return props.reset !== state.reset ? { error: false, reset: props.reset } : null;
  }
  render() {
    return this.state.error ? (
      <text fg="red">Render failed. Ctrl+R to reconnect.</text>
    ) : (
      this.props.children
    );
  }
}
export function Shell({ app }: { app: Application }) {
  useSyncExternalStore(app.subscribe, app.snapshot);
  useKeyboard((key) => {
    if (key.ctrl && key.name === "r") void app.refresh();
  });
  return (
    <Runtime.Provider value={app}>
      <box flexDirection="column" flexGrow={1} padding={1} gap={1}>
        <box flexDirection="row">
          <text fg="#67d9bc">TERMINAL / NOTES</text>
          <text> · {app.status}</text>
        </box>
        {app.error ? <text fg="#ffbc66">{app.error}</text> : null}
        <RenderErrorBoundary reset={app.generation}>
          <Suspense fallback={<text>Loading…</text>}>
            {app.tree ?? <text>Connecting…</text>}
          </Suspense>
        </RenderErrorBoundary>
        <text fg="#8b98a5">Ctrl+R reconnect · Ctrl+C quit</text>
      </box>
    </Runtime.Provider>
  );
}
export function createApplication(options: ApplicationOptions) {
  return new Application(options);
}
export async function run(create: (options: any) => Application) {
  const urlIndex = process.argv.indexOf("--url");
  const url =
    urlIndex >= 0
      ? process.argv[urlIndex + 1]
      : (process.env.TERMINAL_URL ?? "http://127.0.0.1:3000");
  const app = create({ url, token: process.env.TERMINAL_TOKEN });
  process.on("message", (message: any) => {
    if (message?.type === "build-error") {
      app.error = message.message;
      app.notify();
    }
  });
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const root = createRoot(renderer);
  root.render(<Shell app={app} />);
  const stop = () => {
    renderer.destroy();
    process.exit(0);
  };
  renderer.keyInput.on("keypress", (key) => {
    if (key.ctrl && key.name === "c") stop();
  });
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await app.navigate("/");
}
