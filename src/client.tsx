/** @jsxImportSource @opentui/react */
import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import * as z from "zod/mini";
import { createCliRenderer } from "@opentui/core";
import { createRoot, useRenderer } from "@opentui/react";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider, useActiveKeys } from "@opentui/keymap/react";
import {
  RouterProvider,
  createMemoryHistory,
  useRouterState,
  createRouter,
  redirect,
  type AnyRoute,
  type AnyRouter,
} from "@tanstack/react-router";
import { installResolver, createServerReference, type ModuleResolver } from "./flight/client";
import { readNotFound } from "./not-found";
import { connect, serverUrl } from "./connect";
import { messageOf } from "./guards";
import {
  AuthenticationRequired,
  BuildMismatch,
  createHttpTransport,
  isReactNode,
  networkFromEnv,
  type Fetch,
  type NetworkConditions,
  type RouteParams,
  type RouteSearch,
  type Transport,
  type TransportEvent,
} from "./transport";
export { AuthenticationRequired, BuildMismatch, TransportError } from "./transport";
export type {
  Fault,
  Fetch,
  NetworkConditions,
  Outcome,
  RouteParams,
  RouteSearch,
  Transport,
  TransportEvent,
} from "./transport";
/** A transport event, or a resolved navigation. */
export type ApplicationEvent = TransportEvent | { type: "navigation"; path: string };
export type { ErrorProps, LayoutProps, LoadingProps, NotFoundProps } from "./route-tree";
// Keybindings are OpenTUI's keymap, re-exported so every layer shares the Shell's instance.
// A binding's `desc` (and `group`) feeds `<KeyHelp />`.
export { useActiveKeys, useBindings, useKeymap, usePendingSequence } from "@opentui/keymap/react";
// TanStack Router owns navigation state. These primitives are re-exported, not wrapped,
// so Client Components share the bundled router instance and the application's
// generated `Register` types. `<Link>` renders a DOM anchor and is intentionally absent.
export {
  useCanGoBack,
  useLocation,
  useMatchRoute,
  useNavigate,
  useParams,
  useRouter,
  useRouterState,
  useSearch,
} from "@tanstack/react-router";

export type ApplicationOptions = {
  url: string;
  buildId: string;
  resolveModule: ModuleResolver;
  /** `routeTree` exported by the generated `app/routeTree.gen.ts`. */
  routeTree: AnyRoute;
  token?: string;
  timeoutMs?: number;
  /** Additional simulated round-trip latency for every application request. */
  latencyMs?: number;
  /** Simulated jitter, slow chunks and faults (development). */
  network?: NetworkConditions;
  fetch?: Fetch;
  /** Replaces the HTTP/Flight transport. */
  transport?: Transport;
  initialPath?: string;
  /** Shown in the framework heading; the build passes the application directory name. */
  title?: string;
};

// TanStack scroll restoration calls the global scrollTo() after every rendered load.
// OpenTUI already installs a minimal global window; a terminal has no page to scroll.
function installTerminalGlobals() {
  if (!("scrollTo" in globalThis)) Object.assign(globalThis, { scrollTo: () => {} });
}

let current: Application;
export function actionReference(id: string) {
  return createServerReference(id, (key: string, args: unknown[]) => {
    if (!current) throw new Error("Application not mounted");
    return current.callServer(key, args);
  });
}

function statusOf(error: unknown) {
  if (error instanceof BuildMismatch) return "Incompatible build";
  if (error instanceof AuthenticationRequired) return "Authentication required";
  return "Disconnected";
}

export class Application {
  readonly transport: Transport;
  // Typed per application through the generated `Register`, not here.
  readonly router: AnyRouter;
  /** Last known reachability of the Server, updated by every request. */
  status = "Connecting";
  /** Why the mounted route could not be refreshed; cleared by the next success. */
  error = "";
  /** Development only: the last build failure, shown until the next successful build. */
  buildError = "";
  /** Set by `run()`: ends the terminal Client (Ctrl+C). */
  quit: (() => void) | undefined;
  private revision = 0;
  private listeners = new Set<() => void>();
  private invalidationListeners = new Set<(paths: readonly string[]) => void>();
  private nextSignal: AbortSignal | undefined;
  private eventListeners = new Set<(event: ApplicationEvent) => void>();
  private purgeAfterLoad = false;
  readonly options: ApplicationOptions;
  constructor(options: ApplicationOptions) {
    this.options = options;
    installTerminalGlobals();
    installResolver(options.resolveModule);
    this.transport =
      options.transport ??
      createHttpTransport({
        url: options.url,
        buildId: options.buildId,
        token: options.token,
        timeoutMs: options.timeoutMs,
        latencyMs: options.latencyMs,
        network: options.network,
        fetch: options.fetch,
        callServer: this.callServer,
        // Not awaited: a confirmed result never waits for, nor fails with, the refresh.
        onInvalidate: (paths) => void this.invalidate(paths).catch(() => {}),
        onEvent: (event) => this.emit(event),
      });
    this.router = createRouter({
      routeTree: options.routeTree,
      context: { app: this },
      history: createMemoryHistory({ initialEntries: [options.initialPath ?? "/"] }),
      isServer: false,
      origin: "http://terminal.invalid",
      defaultPendingMs: 0,
      defaultPendingMinMs: 0,
      // Plain URL strings: TanStack's default JSON coercion would turn "42" into 42.
      parseSearch: (search) => Object.fromEntries(new URLSearchParams(search)),
      stringifySearch: (search) => {
        const query = new URLSearchParams(
          Object.entries(search).flatMap(([key, value]) =>
            value === undefined || value === null ? [] : [[key, String(value)]],
          ),
        ).toString();
        return query ? `?${query}` : "";
      },
    });
    // A commit moves the route being left into the cache: repeat a purge requested
    // while that navigation was pending.
    this.router.subscribe("onResolved", ({ toLocation }: { toLocation: { pathname: string } }) => {
      this.emit({ type: "navigation", path: toLocation.pathname });
      if (!this.purgeAfterLoad) return;
      this.purgeAfterLoad = false;
      this.router.clearCache();
    });
    // Generated action proxies are module-level functions with no React context: they reach
    // the one Application of this process through `current`, set by its constructor.
    // oxlint-disable-next-line typescript/no-this-alias -- the process-wide registration above.
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
  private report(status: string, error = "") {
    this.status = status;
    this.error = error;
    this.notify();
  }
  /**
   * Replaces the bearer for later requests and drops every cached private tree: a
   * route rendered for another identity must never be shown again. Local state the
   * application keeps (Drafts, pending operations) is the application's to clear.
   */
  setToken = (token?: string) => {
    this.transport.setToken(token);
    this.purge();
  };
  private purge() {
    this.router.clearCache();
    if (this.router.state.status === "pending") this.purgeAfterLoad = true;
  }
  /** Revalidates the destination, or the mounted route, keeping it on failure. */
  refresh = () => this.invalidate();
  /**
   * Revalidates the routes under `paths` (all by default) and tells `useInvalidation`
   * subscribers, for data read outside route loaders. Server Functions trigger it with
   * `invalidate()` on the Server; Client code may call it after its own changes.
   */
  invalidate = (paths: readonly string[] = ["/"]) => {
    for (const listener of this.invalidationListeners) listener(paths);
    const covers = (pathname: string) =>
      paths.some(
        (p) => p === "/" || pathname === p || pathname.startsWith(p.endsWith("/") ? p : p + "/"),
      );
    return paths.includes("/")
      ? this.router.invalidate()
      : this.router.invalidate({ filter: (match: { pathname: string }) => covers(match.pathname) });
  };
  /**
   * Runs `call` with `signal` bound to the Server Function it calls synchronously. Flight
   * references call `callServer` synchronously, so the signal reaches that one request;
   * aborting it cancels the request and any stream it still returns.
   */
  withSignal = <T,>(signal: AbortSignal, call: () => T): T => {
    this.nextSignal = signal;
    try {
      return call();
    } finally {
      this.nextSignal = undefined;
    }
  };
  /**
   * Observes requests (with chunks, timings and outcomes) and navigations. Listeners run
   * synchronously on the hot path: keep them cheap, and never let them throw.
   */
  onEvent = (listener: (event: ApplicationEvent) => void) => {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  };
  private emit(event: ApplicationEvent) {
    for (const listener of this.eventListeners) listener(event);
  }
  onInvalidate = (listener: (paths: readonly string[]) => void) => {
    this.invalidationListeners.add(listener);
    return () => {
      this.invalidationListeners.delete(listener);
    };
  };
  /** Escape: returns locally to the last resolved route without refetching it. */
  cancel = () => {
    const { status, location, resolvedLocation } = this.router.state;
    if (status !== "pending" || !resolvedLocation || resolvedLocation.href === location.href)
      return;
    void this.router.navigate({
      href: resolvedLocation.href,
      replace: true,
      state: { terminalRestore: true },
    });
  };
  /** Loader of every generated page route. */
  async renderPage(
    routeId: string,
    params: RouteParams,
    load: { signal: AbortSignal; href: string; route: string; search?: RouteSearch },
  ): Promise<React.ReactNode> {
    // Read before the request: a revalidation of the resolved location keeps its tree.
    const refreshing = this.router.state.resolvedLocation?.href === load.href;
    const mounted: unknown = refreshing
      ? this.router.state.matches.find((m: { routeId: string }) => m.routeId === load.route)
          ?.loaderData
      : undefined;
    try {
      const tree = await this.transport.render(routeId, params, load.signal, load.search ?? {});
      // A superseded load may still answer; only the current one reports status.
      if (!load.signal.aborted) this.report("Connected");
      return tree;
    } catch (e) {
      if (load.signal.aborted) throw e; // superseded: TanStack discards this load
      // An answer, not a failure: the page's not-found screen replaces even a mounted tree.
      if (readNotFound(e)) {
        this.report("Connected");
        throw e;
      }
      if (e instanceof BuildMismatch) this.purge();
      if (e instanceof AuthenticationRequired && e.loginPath) {
        this.report(statusOf(e));
        throw redirect({ href: e.loginPath });
      }
      // A failed refresh keeps the mounted tree, its focus and its Drafts; a failed
      // navigation shows the error in the page slot, inside the persistent layouts.
      if (mounted !== undefined && isReactNode(mounted)) {
        this.report(statusOf(e), messageOf(e));
        return mounted;
      }
      this.report(statusOf(e));
      throw e;
    }
  }
  /**
   * Every Server Function call. A failure is rethrown as is, with its `outcome`: the
   * calling code decides whether to retry, resolve, redirect or only show it.
   */
  callServer = async (id: string, args: unknown[]) => {
    // Read before the first await: `withSignal` sets it for this call only.
    const signal = this.nextSignal;
    this.nextSignal = undefined;
    try {
      const value = await this.transport.call(id, args, signal);
      this.report("Connected", this.error);
      // No automatic refresh: the code that mutates calls router.invalidate().
      return value;
    } catch (e) {
      if (e instanceof BuildMismatch) this.purge();
      this.report(statusOf(e), this.error);
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
export type LiveState<T> = {
  /** Received values, the latest `limit` ones. */
  items: readonly T[];
  done: boolean;
  /** Why the stream stopped early: a `TransportError` carries its `outcome`. */
  error: unknown;
};
const DEFAULT_LIVE_LIMIT = 1000;
/**
 * Subscribes, while mounted, to a Server Function returning an async iterable (an
 * `async function*` in a "use server" module). The request opens on mount, when `args`
 * change, and is cancelled on unmount; the Server generator is then stopped. Nothing
 * reconnects by itself: `error` tells why the stream ended, the application decides.
 */
export function useLive<T, A extends unknown[]>(
  source: (...args: A) => Promise<AsyncIterable<T>> | AsyncIterable<T>,
  args: A,
  options: { limit?: number } = {},
): LiveState<T> {
  const app = useApplication();
  const limit = options.limit ?? DEFAULT_LIVE_LIMIT;
  // A subscription's values are tagged with its arguments: new arguments start empty.
  const key = JSON.stringify(args);
  const [state, setState] = useState<LiveState<T> & { key: string }>({
    key,
    items: [],
    done: false,
    error: undefined,
  });
  const latestArgs = useRef(args);
  useLayoutEffect(() => {
    latestArgs.current = args;
  });
  useEffect(() => {
    const controller = new AbortController();
    const update = (next: (s: LiveState<T>) => Partial<LiveState<T>>) =>
      setState((s) => {
        const current = s.key === key ? s : { key, items: [], done: false, error: undefined };
        return { ...current, ...next(current) };
      });
    void (async () => {
      try {
        const iterable = await app.withSignal(controller.signal, () =>
          source(...latestArgs.current),
        );
        for await (const item of iterable) {
          if (controller.signal.aborted) return;
          update((s) => ({ items: [...s.items, item].slice(-limit) }));
        }
        if (!controller.signal.aborted) update(() => ({ done: true }));
      } catch (error: unknown) {
        if (!controller.signal.aborted) update(() => ({ done: true, error }));
      }
    })();
    return () => controller.abort();
  }, [app, source, key, limit]);
  return state.key === key ? state : { items: [], done: false, error: undefined };
}
/**
 * Calls `listener` whenever routes are invalidated, by the Server (`invalidate()` in a
 * Server Function) or the Client: for data a component reads through Server Functions,
 * which no route loader refreshes.
 */
export function useInvalidation(listener: (paths: readonly string[]) => void) {
  const app = useApplication();
  const latest = useRef(listener);
  useLayoutEffect(() => {
    latest.current = listener;
  });
  useEffect(() => app.onInvalidate((paths) => latest.current(paths)), [app]);
}
/**
 * Connection state for the application's own chrome: Server reachability, the last
 * refresh failure, the development build error, and what the router is doing.
 */
export function useConnection() {
  const app = useApplication();
  useSyncExternalStore(app.subscribe, app.snapshot);
  // A navigation changes the location; a refresh reloads the resolved one in the
  // background, visible only as fetching matches.
  const activity = useRouterState({
    select: (s) =>
      s.resolvedLocation && s.resolvedLocation.href !== s.location.href
        ? ("navigate" as const)
        : !s.resolvedLocation
          ? ("connect" as const)
          : s.status === "pending" || s.matches.some((m) => m.isFetching)
            ? ("refresh" as const)
            : ("idle" as const),
  });
  return {
    status: app.status,
    error: app.error,
    buildError: app.buildError,
    activity,
    refresh: app.refresh,
  };
}
type DebugState = {
  requests: number;
  inFlight: number;
  bytes: number;
  lastRtt: number | undefined;
  recent: readonly string[];
};
const describeEvent = (event: ApplicationEvent) => {
  if (event.type === "navigation") return `navigate ${event.path}`;
  const at = `${event.kind} ${event.target.split("#").at(-1)}`;
  if (event.type === "request") return `→ ${at}`;
  if (event.type === "response") return `← ${at} ${event.status} ${event.ms}ms`;
  if (event.type === "error") return `✗ ${at} ${event.outcome} ${event.ms}ms`;
  if (event.type === "end") return `■ ${at} ${event.bytes}B${event.cancelled ? " cancelled" : ""}`;
  return "";
};
/**
 * What the Client asked the Server since this overlay was mounted: requests, requests
 * still open, bytes read, the last round trip and the latest events. An application
 * decides where and when to show it (for instance behind a key binding).
 */
export function DebugOverlay({ limit = 6 }: { limit?: number }) {
  const app = useApplication();
  const [state, setState] = useState<DebugState>({
    requests: 0,
    inFlight: 0,
    bytes: 0,
    lastRtt: undefined,
    recent: [],
  });
  useEffect(
    () =>
      app.onEvent((event) => {
        if (event.type === "chunk") {
          setState((s) => ({ ...s, bytes: s.bytes + event.bytes }));
          return;
        }
        setState((s) => ({
          requests: s.requests + (event.type === "request" ? 1 : 0),
          inFlight:
            s.inFlight +
            (event.type === "request"
              ? 1
              : event.type === "end" || event.type === "error"
                ? -1
                : 0),
          bytes: s.bytes,
          lastRtt: event.type === "response" ? event.ms : s.lastRtt,
          recent: [...s.recent, describeEvent(event)].slice(-limit),
        }));
      }),
    [app, limit],
  );
  return (
    <box id="airtty-debug" flexDirection="column" flexShrink={0} border borderColor="#526d82">
      <text height={1} wrapMode="none" truncate fg="#67d9bc">
        requests {state.requests} · open {Math.max(0, state.inFlight)} · {state.bytes}B · rtt{" "}
        {state.lastRtt === undefined ? "–" : `${state.lastRtt}ms`}
      </text>
      {state.recent.map((line, i) => (
        <text key={i} height={1} wrapMode="none" truncate fg="#8b98a5">
          {line}
        </text>
      ))}
    </box>
  );
}

/** The part of an OpenTelemetry `Tracer` the adapter uses: pass `trace.getTracer(…)`. */
export type TracerLike = {
  startSpan(
    name: string,
    options?: { attributes?: Record<string, string | number | boolean> },
  ): {
    setAttribute(key: string, value: string | number | boolean): unknown;
    setStatus(status: { code: number; message?: string }): unknown;
    end(): void;
  };
};
/**
 * One span per request, from its start to the end (or failure) of its body, with its
 * target, status, bytes and outcome. Returns the function that stops tracing.
 */
export function instrumentTracing(app: Application, tracer: TracerLike) {
  const spans = new Map<number, ReturnType<TracerLike["startSpan"]>>();
  const ERROR = 2; // OpenTelemetry SpanStatusCode.ERROR
  return app.onEvent((event) => {
    if (event.type === "navigation") return;
    if (event.type === "request") {
      spans.set(
        event.id,
        tracer.startSpan(`airtty.${event.kind}`, {
          attributes: { "airtty.kind": event.kind, "airtty.target": event.target },
        }),
      );
      return;
    }
    const span = spans.get(event.id);
    if (!span) return;
    if (event.type === "response") span.setAttribute("http.response.status_code", event.status);
    if (event.type === "end") {
      span.setAttribute("airtty.bytes", event.bytes);
      if (event.cancelled) span.setAttribute("airtty.cancelled", true);
      span.end();
      spans.delete(event.id);
    }
    if (event.type === "error") {
      span.setAttribute("airtty.outcome", event.outcome);
      span.setStatus({ code: ERROR, message: event.message });
      span.end();
      spans.delete(event.id);
    }
  });
}
/**
 * The keys active where the focus is, with their `desc`: an application's help screen,
 * generated from the layers mounted right now instead of written by hand.
 */
export function KeyHelp({
  groups,
  inline = false,
  fg = "#8b98a5",
  accent = "#67d9bc",
}: {
  /** Only bindings whose `group` is listed; every described binding by default. */
  groups?: readonly string[];
  /** One line (`key desc · key desc`) instead of one binding per line. */
  inline?: boolean;
  fg?: string;
  accent?: string;
}) {
  const keys = useActiveKeys({ includeMetadata: true }).flatMap((key) => {
    const attrs = { ...key.commandAttrs, ...key.bindingAttrs };
    const desc = attrs.desc;
    if (typeof desc !== "string") return [];
    if (groups && !groups.includes(String(attrs.group))) return [];
    return [{ display: key.display, desc }];
  });
  if (inline)
    return (
      <text height={1} wrapMode="none" truncate fg={fg}>
        {keys.map(({ display, desc }, i) => (
          <span key={display}>
            {i ? " · " : ""}
            <span fg={accent}>{display}</span> {desc}
          </span>
        ))}
      </text>
    );
  return (
    <box flexDirection="column" flexShrink={0}>
      {keys.map(({ display, desc }) => (
        <text key={display} height={1} wrapMode="none" truncate fg={fg}>
          <span fg={accent}>{display}</span> {desc}
        </text>
      ))}
    </box>
  );
}
export function Shell({ app }: { app: Application }) {
  const renderer = useRenderer();
  const [keymap] = useState(() => createDefaultOpenTuiKeymap(renderer));
  return (
    <KeymapProvider keymap={keymap}>
      <Runtime.Provider value={app}>
        <RouterProvider router={app.router} />
      </Runtime.Provider>
    </KeymapProvider>
  );
}
export function createApplication(options: ApplicationOptions) {
  return new Application(options);
}
// The Client's own environment; the Server's URL comes from `serverUrl` (src/connect.ts)
// and network conditions from `networkFromEnv`.
const ClientEnvironment = z.object({
  AIRTTY_TOKEN: z.optional(z.string()),
  AIRTTY_LATENCY_MS: z._default(z.coerce.number().check(z.gte(0)), 0),
});
/** What `airtty dev` sends the Client it supervises (src/cli.ts). */
const DevMessage = z.object({ type: z.literal("build-error"), message: z.string() });
export async function run(
  create: (options: Record<string, unknown>) => Application,
  { name = "airtty" }: { name?: string } = {},
) {
  const env = ClientEnvironment.safeParse(process.env);
  if (!env.success) throw new Error(`Invalid Client environment: ${z.prettifyError(env.error)}`);
  // Resolved before the renderer takes the terminal: ssh may prompt for a passphrase.
  const connection = await serverUrl({ name })
    .then((url) => connect(url))
    .catch((error: unknown) => {
      console.error(messageOf(error));
      process.exit(1);
    });
  const app = create({
    url: connection.url,
    fetch: connection.fetch,
    token: env.data.AIRTTY_TOKEN,
    latencyMs: env.data.AIRTTY_LATENCY_MS,
    network: networkFromEnv(process.env),
  });
  process.on("message", (received: unknown) => {
    const message = DevMessage.safeParse(received);
    if (!message.success) return;
    app.buildError = message.data.message;
    app.notify();
  });
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const root = createRoot(renderer);
  // RouterProvider's Transitioner performs the initial load.
  root.render(<Shell app={app} />);
  const stop = () => {
    renderer.destroy();
    connection.close();
    process.exit(0);
  };
  app.quit = stop;
  renderer.keyInput.on("keypress", (key) => {
    if (key.ctrl && key.name === "c") stop();
  });
  // SIGHUP: the terminal closed; the Client and its tunnel must not outlive it.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, stop);
}
