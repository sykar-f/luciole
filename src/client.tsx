/** @jsxImportSource @opentui/react */
import { matchRoute } from "./routes";
import { setTimeout as delay } from "node:timers/promises";
import React, {
  Component,
  Suspense,
  createContext,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useTimeline } from "@opentui/react";
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
export class AuthenticationRequired extends TransportError {
  constructor(
    message: string,
    readonly loginPath?: string,
  ) {
    super(message);
  }
}
export type LoadingProps = { path: string; params: Record<string, string> };
export type Navigation = { path: string; kind: "navigate" | "refresh" };
export type ApplicationOptions = {
  url: string;
  buildId: string;
  resolveModule: ModuleResolver;
  token?: string;
  timeoutMs?: number;
  /** Additional simulated round-trip latency for every application request. */
  latencyMs?: number;
  loadingRoutes?: { path: string; component?: React.ComponentType<LoadingProps> }[];
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
  private token?: string;
  path = "/";
  pendingNavigation: Navigation | null = null;
  private navigationRequest?: AbortController;
  status = "Connecting";
  tree: any = null;
  generation = 0;
  revision = 0;
  error = "";
  private listeners = new Set<() => void>();
  constructor(readonly options: ApplicationOptions) {
    if (!Number.isFinite(options.latencyMs ?? 0) || (options.latencyMs ?? 0) < 0)
      throw new Error("latencyMs must be a finite non-negative number");
    installResolver(options.resolveModule);
    this.token = options.token;
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
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 10000);
    const signal = init.signal ? AbortSignal.any([timeout, init.signal]) : timeout;
    const oneWayMs = (this.options.latencyMs ?? 0) / 2;
    try {
      if (oneWayMs) await delay(oneWayMs, undefined, { signal });
      const response = await (this.options.fetch ?? fetch)(new URL(path, this.options.url), {
        ...init,
        headers,
        signal,
      });
      if (oneWayMs) await delay(oneWayMs, undefined, { signal });
      if (response.status === 409) throw new BuildMismatch(await response.text());
      if (response.status === 401)
        throw new AuthenticationRequired(
          await response.text(),
          response.headers.get("x-terminal-login") ?? undefined,
        );
      if (!response.ok)
        throw new TransportError(`HTTP ${response.status}: ${await response.text()}`);
      return response;
    } catch (e) {
      throw e instanceof TransportError
        ? e
        : new TransportError(e instanceof Error ? e.message : String(e));
    }
  }
  setToken = (token?: string) => {
    this.token = token;
  };
  async navigate(path: string) {
    if (!path.startsWith("/") || path.startsWith("//"))
      throw new Error("Expected application route");
    const generation = ++this.generation;
    this.navigationRequest?.abort();
    const controller = new AbortController();
    this.navigationRequest = controller;
    this.pendingNavigation = {
      path,
      kind: this.tree !== null && path === this.path ? "refresh" : "navigate",
    };
    this.error = "";
    this.notify();
    try {
      const response = await this.request(`/render?path=${encodeURIComponent(path)}`, {
        signal: controller.signal,
      });
      const pending = decode(response.body!, this.callServer);
      // Wait only for the root model. Nested Flight promises remain progressive Suspense content.
      const tree = await pending;
      if (generation !== this.generation) return;
      this.pendingNavigation = null;
      this.navigationRequest = undefined;
      this.tree = tree;
      this.path = path;
      this.status = "Connected";
      this.error = "";
      this.notify();
    } catch (e) {
      if (generation !== this.generation) return;
      if (e instanceof AuthenticationRequired && e.loginPath && e.loginPath !== path) {
        this.status = "Authentication required";
        this.error = "";
        await this.navigate(e.loginPath);
        return;
      }
      this.pendingNavigation = null;
      this.navigationRequest = undefined;
      this.status =
        e instanceof BuildMismatch
          ? "Incompatible build"
          : e instanceof AuthenticationRequired
            ? "Authentication required"
            : "Disconnected";
      this.error = (e as Error).message;
      this.notify();
    }
  }
  cancelNavigation = () => {
    if (!this.pendingNavigation || this.tree === null) return;
    ++this.generation;
    this.navigationRequest?.abort();
    this.navigationRequest = undefined;
    this.pendingNavigation = null;
    this.notify();
  };
  // Refresh the destination if navigation is in progress, never bounce back to the old page.
  refresh = () => this.navigate(this.pendingNavigation?.path ?? this.path);
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
      if (e instanceof AuthenticationRequired && e.loginPath) void this.navigate(e.loginPath);
      this.status =
        e instanceof BuildMismatch
          ? "Incompatible build"
          : e instanceof AuthenticationRequired
            ? "Authentication required"
            : "Disconnected";
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
  useSyncExternalStore(app.subscribe, app.snapshot);
  return {
    path: app.path,
    pending: app.pendingNavigation,
    cancel: app.cancelNavigation,
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
function AnimatedLoading({ label }: { label: string }) {
  const target = useRef<any>(null);
  const timeline = useTimeline({ autoplay: false, duration: 1700, loop: true });
  useEffect(() => {
    if (!target.current) return;
    timeline.add(target.current, {
      duration: 850,
      ease: "inOutSine",
      opacity: 0.2,
      loop: true,
      alternate: true,
    });
    timeline.play();
    return () => {
      timeline.pause();
    };
  }, [timeline]);
  return (
    <text ref={target} id="terminal-loading" height={1} flexShrink={0} wrapMode="none" truncate>
      {label}
    </text>
  );
}
function NavigationLoading({ app, path }: { app: Application; path: string }) {
  // Bad route parameters are reported by the navigation request, not thrown during rendering.
  let matched;
  try {
    matched = matchRoute(app.options.loadingRoutes ?? [], path);
  } catch {
    /* generic fallback */
  }
  const Loading = matched?.route.component;
  return Loading ? (
    React.createElement(Loading, { path, params: matched!.params })
  ) : (
    <AnimatedLoading label="Loading…" />
  );
}
export function Shell({ app }: { app: Application }) {
  useSyncExternalStore(app.subscribe, app.snapshot);
  useKeyboard((key) => {
    if (key.ctrl && key.name === "r") void app.refresh();
    if (key.name === "escape" && app.pendingNavigation?.kind === "navigate") app.cancelNavigation();
  });
  return (
    <Runtime.Provider value={app}>
      <box flexDirection="column" flexGrow={1} padding={1} gap={1}>
        <text id="terminal-heading" height={1} flexShrink={0} wrapMode="none" truncate fg="#67d9bc">
          TERMINAL / NOTES · {app.status}
          {app.pendingNavigation?.kind === "refresh" ? " · Refreshing…" : ""}
          {app.pendingNavigation?.kind === "navigate" && app.tree !== null ? " · Esc cancel" : ""}
        </text>
        {app.error ? <text fg="#ffbc66">{app.error}</text> : null}
        <RenderErrorBoundary reset={app.generation}>
          <Suspense
            fallback={
              <NavigationLoading app={app} path={app.pendingNavigation?.path ?? app.path} />
            }
          >
            {app.pendingNavigation?.kind === "navigate" ? (
              <NavigationLoading
                key={app.pendingNavigation.path}
                app={app}
                path={app.pendingNavigation.path}
              />
            ) : (
              (app.tree ?? <AnimatedLoading label="Connecting…" />)
            )}
          </Suspense>
        </RenderErrorBoundary>
        <text id="terminal-footer" height={1} flexShrink={0} wrapMode="none" truncate fg="#8b98a5">
          Ctrl+R reconnect · Ctrl+C quit
        </text>
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
  const app = create({
    url,
    token: process.env.TERMINAL_TOKEN,
    latencyMs: Number(process.env.TERMINAL_LATENCY_MS ?? 0),
  });
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
