/** @jsxImportSource @opentui/react */
import React, {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import * as z from "zod/mini";
import { createCliRenderer, type CliRenderer } from "@opentui/core";
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
  type RouterHistory,
} from "@tanstack/react-router";
import { installResolver, createServerReference, type ModuleResolver } from "./flight/client";
import { readNotFound } from "./not-found";
import { connect, serverUrl } from "./connect";
import { messageOf } from "./guards";
import { Restoration, type Session } from "./restore";
import { Runtime } from "./runtime-context";
import { openSession, SessionId } from "./session";
import {
  AuthenticationRequired,
  BuildMismatch,
  createHttpTransport,
  isReactNode,
  networkFromEnv,
  now,
  type Fetch,
  type NetworkConditions,
  type RequestCause,
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
  RequestCause,
  RequestContext,
  RouteParams,
  RouteSearch,
  Transport,
  TransportEvent,
} from "./transport";
type Navigation = { type: "navigation"; at: number; path: string };
/**
 * A page loader, identified by the route it renders (`routeId`, the request's `target`).
 * `source` is `router-cache` when the router showed its cached tree without calling it:
 * that load has an `end` only.
 */
type Loader = {
  type: "loader";
  at: number;
  routeId: string;
  href: string;
  cause: RequestCause;
  source: "network" | "router-cache";
};
/**
 * A transport event; a resolved navigation; an invalidation, declared by a Server
 * Function (`server`) or by Client code, `refresh()` included (`client`); or a page
 * loader starting and ending, whatever the transport did (a decorator may answer it).
 * Every event carries `at`, in epoch milliseconds.
 */
export type ApplicationEvent =
  | TransportEvent
  | Navigation
  | {
      type: "invalidate";
      at: number;
      paths: readonly string[];
      origin: "server" | "client";
      /** Cache tags, when `invalidate({ tag })` declared some (docs/CACHE.md). */
      tags?: readonly string[];
    }
  | (Loader & { phase: "start" })
  | (Loader & { phase: "end"; ms: number; result: "ok" | "error" | "aborted" });
export type { ErrorProps, LayoutProps, LoadingProps, NotFoundProps } from "./route-tree";
export { Input, Textarea, useRestoredFields } from "./fields";
export type { FieldInputProps, FieldTextareaProps, RestoredFields } from "./fields";
export type { Session, SessionEntry } from "./restore";
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
  /**
   * Decorates the transport in use (`transport`, or the HTTP/Flight one): a cache or a
   * recorder lives in its own module and forwards to `inner`. What it throws reaches
   * the application as is, so it must keep `TransportError`s and their `outcome`.
   */
  wrapTransport?: (inner: Transport) => Transport;
  initialPath?: string;
  /**
   * History and named fields to restore (after a crash or a development rebuild):
   * `run()` reads it from disk. Replaces `initialPath`.
   */
  session?: Session;
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

/** What TanStack's `onResolved` tells of the location it resolved. */
type ResolvedChange = { toLocation: { pathname: string; href: string }; hrefChanged: boolean };

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
  /**
   * Set by `run()`: ends the terminal Client on purpose (Ctrl+C). Its session is
   * deleted, as a browser closed by the user does not offer to restore its tabs.
   */
  quit: (() => void) | undefined;
  private revision = 0;
  private listeners = new Set<() => void>();
  private invalidationListeners = new Set<
    (paths: readonly string[], tags: readonly string[]) => void
  >();
  // The "use cache" tags each loaded tree read, keyed by the tree its match holds.
  private pageTags = new WeakMap<WeakKey, readonly string[]>();
  // TanStack route id → the Server routeId its loader renders; and the page loads started
  // by the current navigation, to tell which pages the router served from its cache.
  private pageRoutes = new Map<string, string>();
  private loaded = new Set<string>();
  private nextSignal: AbortSignal | undefined;
  private nextCause: RequestCause | undefined;
  // The revalidation in progress, so its loads report why they run. Overlapping ones
  // keep the latest cause: attribution is best effort, never a guarantee.
  private revalidation: { cause: RequestCause } | undefined;
  private eventListeners = new Set<(event: ApplicationEvent) => void>();
  private purgeAfterLoad = false;
  private bearer: string | undefined;
  private tokenListeners = new Set<(token: string | undefined) => void>();
  readonly options: ApplicationOptions;
  /** The router's history, typed: `router` is not (see above). */
  readonly history: RouterHistory;
  /** The history and the text of named fields, as a browser keeps a session. */
  readonly restoration: Restoration;
  constructor(options: ApplicationOptions) {
    this.options = options;
    this.bearer = options.token;
    // Entries after the current one are not restored: a memory history created with an
    // `initialIndex` of 0 would open on its last entry instead.
    const restored = options.session?.entries.length
      ? {
          index: options.session.index,
          entries: options.session.entries.slice(0, options.session.index + 1),
        }
      : undefined;
    this.restoration = new Restoration(restored);
    installTerminalGlobals();
    installResolver(options.resolveModule);
    const inner =
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
        onInvalidate: (paths, tags) =>
          void this.revalidate(paths, "server", "invalidation", tags).catch(() => {}),
        onEvent: (event) => this.emit(event),
      });
    this.transport = options.wrapTransport?.(inner) ?? inner;
    this.history = createMemoryHistory({
      initialEntries: restored?.entries.map((e) => e.href) ?? [options.initialPath ?? "/"],
    });
    this.router = createRouter({
      routeTree: options.routeTree,
      context: { app: this },
      history: this.history,
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
    this.router.subscribe("onBeforeNavigate", () => {
      this.loaded.clear();
      this.restoration.sync(this.history);
    });
    this.router.subscribe("onResolved", (change: ResolvedChange) => {
      const { toLocation } = change;
      this.restoration.sync(this.history);
      this.emit({ type: "navigation", at: now(), path: toLocation.pathname });
      if (change.hrefChanged) this.reportCachedPages(toLocation.href);
      if (!this.purgeAfterLoad) return;
      this.purgeAfterLoad = false;
      this.router.clearCache();
    });
    // Generated action proxies are module-level functions with no React context: they reach
    // the one Application of this process through `current`, set by its constructor.
    // oxlint-disable-next-line typescript/no-this-alias -- the process-wide registration above.
    current = this;
    this.restoration.sync(this.history);
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
   * Replaces the bearer for later requests, drops every cached private tree and reloads
   * the current routes under the new bearer: a route rendered for another identity must
   * never be shown again. Replacing a bearer (sign-out, another account) also forgets
   * the text of named fields; the first sign-in of a Client keeps it, so text restored
   * after a crash survives the sign-in it requires. Local state the application keeps
   * (Drafts, pending operations) is the application's to clear.
   */
  setToken = (token?: string) => {
    if (this.bearer !== undefined) this.restoration.clear();
    this.bearer = token;
    this.transport.setToken(token);
    for (const listener of this.tokenListeners) listener(token);
    this.purge();
    // Loads still in flight (a navigation, a background revalidation) asked with the
    // previous bearer: superseding them is what keeps their answers off the screen.
    void this.revalidating("invalidation", () => this.router.invalidate()).catch(() => {});
  };
  private purge() {
    this.router.clearCache();
    if (this.router.state.status === "pending") this.purgeAfterLoad = true;
  }
  /**
   * Called with each new bearer. The development supervisor uses it to hand the bearer to
   * the Client it restarts after a rebuild, in memory only.
   */
  onTokenChange = (listener: (token: string | undefined) => void) => {
    this.tokenListeners.add(listener);
    return () => {
      this.tokenListeners.delete(listener);
    };
  };
  // Pages of the resolved location whose loader did not run: the router's cache served
  // them without a request (fresh within `staleTime`, preloaded, or Escape). Nothing
  // started, so only the `end` of a load that took no time.
  private reportCachedPages(href: string) {
    const routes: string[] = this.router.state.matches.map((m: { routeId: string }) => m.routeId);
    for (const route of routes) {
      const routeId = this.pageRoutes.get(route);
      if (!routeId || this.loaded.has(`${route}\0${href}`)) continue;
      this.emit({
        type: "loader",
        routeId,
        href,
        cause: "navigation",
        source: "router-cache",
        phase: "end",
        at: now(),
        ms: 0,
        result: "ok",
      });
    }
  }
  /** Revalidates the destination, or the mounted route, keeping it on failure. */
  refresh = () => this.revalidate(["/"], "client", "refresh");
  /**
   * Revalidates the routes under `paths` (all by default) and tells `useInvalidation`
   * subscribers, for data read outside route loaders. Server Functions trigger it with
   * `invalidate()` on the Server; Client code may call it after its own changes.
   */
  invalidate = (paths: readonly string[] = ["/"]) =>
    this.revalidate(paths, "client", "invalidation");
  private revalidate(
    paths: readonly string[],
    origin: "server" | "client",
    cause: RequestCause,
    tags: readonly string[] = [],
  ) {
    this.emit({ type: "invalidate", at: now(), paths, origin, ...(tags.length ? { tags } : {}) });
    for (const listener of this.invalidationListeners) listener(paths, tags);
    const covers = (pathname: string) =>
      paths.some(
        (p) => p === "/" || pathname === p || pathname.startsWith(p.endsWith("/") ? p : p + "/"),
      );
    // A tree whose tags are unknown (still loading, or answered by a transport that sends
    // none) may have read any of them: revalidated too.
    const touched = (tree: unknown) => {
      if (!tags.length) return false;
      const read = typeof tree === "object" && tree !== null ? this.pageTags.get(tree) : undefined;
      return !read || read.some((tag) => tags.includes(tag));
    };
    return this.revalidating(cause, () =>
      paths.includes("/")
        ? this.router.invalidate()
        : this.router.invalidate({
            filter: (match: { pathname: string; loaderData?: unknown }) =>
              covers(match.pathname) || touched(match.loaderData),
          }),
    );
  }
  private revalidating(cause: RequestCause, start: () => Promise<void>) {
    const mark = { cause };
    this.revalidation = mark;
    const done = () => {
      if (this.revalidation === mark) this.revalidation = undefined;
    };
    const pending = start();
    pending.then(done, done);
    return pending;
  }
  /**
   * Runs `call` with `signal` bound to the Server Function it calls synchronously. Flight
   * references call `callServer` synchronously, so the signal reaches that one request;
   * aborting it cancels the request and any stream it still returns. `cause` labels that
   * request in events (`useLive` passes `live`).
   */
  withSignal = <T,>(signal: AbortSignal, call: () => T, cause?: RequestCause): T => {
    this.nextSignal = signal;
    this.nextCause = cause;
    try {
      return call();
    } finally {
      this.nextSignal = undefined;
      this.nextCause = undefined;
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
  onInvalidate = (listener: (paths: readonly string[], tags: readonly string[]) => void) => {
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
    load: {
      signal: AbortSignal;
      href: string;
      route: string;
      search?: RouteSearch;
      preload?: boolean;
    },
  ): Promise<React.ReactNode> {
    // Read before the request: a revalidation of the resolved location keeps its tree.
    const refreshing = this.router.state.resolvedLocation?.href === load.href;
    const mounted: unknown = refreshing
      ? this.router.state.matches.find((m: { routeId: string }) => m.routeId === load.route)
          ?.loaderData
      : undefined;
    this.pageRoutes.set(load.route, routeId);
    if (!load.preload) this.loaded.add(`${load.route}\0${load.href}`);
    const loader = {
      type: "loader",
      routeId,
      href: load.href,
      source: "network",
      cause: load.preload
        ? "preload"
        : refreshing
          ? (this.revalidation?.cause ?? "unknown")
          : "navigation",
    } as const;
    const started = performance.now();
    let result: "ok" | "error" | "aborted" = "error";
    this.emit({ ...loader, phase: "start", at: now() });
    try {
      // The tags arrive once the page finished rendering, after its tree: until then the
      // route counts as having read any tag.
      let page: unknown, tags: readonly string[] | undefined;
      const record = () => {
        if (tags && typeof page === "object" && page !== null) this.pageTags.set(page, tags);
      };
      const tree = await this.transport.render(routeId, params, load.signal, load.search ?? {}, {
        cause: loader.cause,
        onTags: (read) => {
          tags = read;
          record();
        },
      });
      page = tree;
      record();
      result = load.signal.aborted ? "aborted" : "ok";
      // A superseded load may still answer; only the current one reports status.
      if (!load.signal.aborted) this.report("Connected");
      return tree;
    } catch (e) {
      if (load.signal.aborted) {
        result = "aborted";
        throw e; // superseded: TanStack discards this load
      }
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
    } finally {
      const ms = Math.round(performance.now() - started);
      this.emit({ ...loader, phase: "end", at: now(), ms, result });
    }
  }
  /**
   * Every Server Function call. A failure is rethrown as is, with its `outcome`: the
   * calling code decides whether to retry, resolve, redirect or only show it.
   */
  callServer = async (id: string, args: unknown[]) => {
    // Read before the first await: `withSignal` sets it for this call only.
    const signal = this.nextSignal,
      cause = this.nextCause ?? "action";
    this.nextSignal = undefined;
    this.nextCause = undefined;
    try {
      const value = await this.transport.call(id, args, signal, { cause });
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
        const iterable = await app.withSignal(
          controller.signal,
          () => source(...latestArgs.current),
          "live",
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
 * which no route loader refreshes. `tags` are the "use cache" tags invalidated, if any.
 */
export function useInvalidation(
  listener: (paths: readonly string[], tags: readonly string[]) => void,
) {
  const app = useApplication();
  const latest = useRef(listener);
  useLayoutEffect(() => {
    latest.current = listener;
  });
  useEffect(() => app.onInvalidate((paths, tags) => latest.current(paths, tags)), [app]);
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
const describeEvent = (event: TransportEvent | Navigation) => {
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
        // Loaders and invalidations are for richer tools; the overlay stays as it was.
        if (event.type === "loader" || event.type === "invalidate") return;
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
    if (!("kind" in event)) return;
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
  /** Set by `airtty dev`: the session this Client reopens after each rebuild. */
  AIRTTY_SESSION: z.optional(SessionId),
  /** Set by src/launcher: what sessions are kept under instead of the Server's URL. */
  AIRTTY_SESSION_KEY: z.optional(z.string().check(z.minLength(1))),
  /** Development only: the address of `airtty devtools` (src/devtools/client-agent.ts). */
  AIRTTY_DEVTOOLS: z.optional(z.string()),
});
/** What `airtty dev` sends the Client it supervises (src/commands/dev.ts). */
const DevMessage = z.union([
  z.object({ type: z.literal("build-error"), message: z.string() }),
  z.object({ type: z.literal("bearer"), token: z.optional(z.string()) }),
]);
// The supervisor answers at once; a Client started by hand with AIRTTY_SESSION only
// waits this long.
const SUPERVISOR_REPLY_MS = 1000;
/**
 * Development only: the bearer the previous Client of this `airtty dev` held. It lives
 * in the supervisor's memory, never on disk, so a rebuild does not ask to sign in again.
 */
function bearerFromSupervisor(send: (message: unknown) => void) {
  return new Promise<string | undefined>((resolve) => {
    const timer = setTimeout(() => done(undefined), SUPERVISOR_REPLY_MS);
    const done = (token: string | undefined) => {
      clearTimeout(timer);
      process.off("message", listener);
      resolve(token);
    };
    const listener = (received: unknown) => {
      const message = DevMessage.safeParse(received);
      if (message.success && message.data.type === "bearer") done(message.data.token);
    };
    process.on("message", listener);
    send({ type: "hello" });
  });
}
export async function run(
  create: (options: Record<string, unknown>) => Application,
  {
    name = "airtty",
    sessionKey,
  }: {
    name?: string;
    /**
     * Keys the sessions this Client restores, instead of the Server's URL: the launcher
     * gives one per app and target, since its local socket changes on every launch.
     */
    sessionKey?: string;
  } = {},
) {
  const env = ClientEnvironment.safeParse(process.env);
  if (!env.success) throw new Error(`Invalid Client environment: ${z.prettifyError(env.error)}`);
  // Resolved before the renderer takes the terminal: ssh may prompt for a passphrase.
  const url = await serverUrl({ name }).catch((error: unknown) => {
    console.error(messageOf(error));
    process.exit(1);
  });
  const connection = await connect(url).catch((error: unknown) => {
    console.error(messageOf(error));
    process.exit(1);
  });
  const supervised =
    env.data.AIRTTY_SESSION !== undefined && process.send
      ? (message: unknown) => void process.send?.(message)
      : undefined;
  const handed = supervised ? await bearerFromSupervisor(supervised) : undefined;
  // Keyed by the address the user gave: a tunnel's local port changes on every start.
  const session = openSession({
    name,
    server: sessionKey ?? env.data.AIRTTY_SESSION_KEY ?? url,
    id: env.data.AIRTTY_SESSION,
  });
  const devtools = env.data.AIRTTY_DEVTOOLS
    ? (await import("./devtools/client-agent")).startClientAgent({
        address: env.data.AIRTTY_DEVTOOLS,
        name,
      })
    : undefined;
  const app = create({
    url: connection.url,
    fetch: connection.fetch,
    token: handed ?? env.data.AIRTTY_TOKEN,
    latencyMs: env.data.AIRTTY_LATENCY_MS,
    network: networkFromEnv(process.env),
    session: session.restored,
    ...(devtools && { wrapTransport: devtools.wrapTransport }),
  });
  // Claims the session at once: another Client starting now must not take it.
  session.flush(app.restoration.snapshot());
  app.restoration.subscribe(() => session.schedule(app.restoration.snapshot()));
  if (supervised) app.onTokenChange((token) => supervised({ type: "bearer", token }));
  process.on("message", (received: unknown) => {
    const message = DevMessage.safeParse(received);
    if (!message.success || message.data.type !== "build-error") return;
    app.buildError = message.data.message;
    app.notify();
  });
  // Handlers first: from here on a signal must stop the tunnel, the renderer is optional.
  let renderer: CliRenderer | undefined;
  const stop = () => {
    renderer?.destroy();
    connection.close();
    process.exit(0);
  };
  // A signal is not the user's choice (a rebuild, a closed terminal, a killed process):
  // the session stays on disk to be restored. Quitting (Ctrl+C, `app.quit`) deletes it.
  const interrupted = () => {
    session.flush(app.restoration.snapshot());
    stop();
  };
  const quit = () => {
    session.remove();
    stop();
  };
  // SIGHUP: the terminal closed; the Client and its tunnel must not outlive it.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, interrupted);
  app.quit = quit;
  renderer = await createCliRenderer({ exitOnCtrlC: false });
  devtools?.attach(app, renderer);
  const root = createRoot(renderer);
  // RouterProvider's Transitioner performs the initial load.
  root.render(<Shell app={app} />);
  renderer.keyInput.on("keypress", (key) => {
    if (key.ctrl && key.name === "c") quit();
  });
}
