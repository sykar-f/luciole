/** @jsxImportSource @opentui/react */
import React, { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRouter,
  redirect,
  type AnyRoute,
  type AnyRouter,
} from "@tanstack/react-router";
import { installResolver, createServerReference, type ModuleResolver } from "./flight/client";
import {
  AuthenticationRequired,
  BuildMismatch,
  createHttpTransport,
  type RouteParams,
  type RouteSearch,
  type Transport,
} from "./transport";
import { DraftStore, type Note, type SaveResult, type Snapshot } from "./draft";
export type { Note, SaveResult, Snapshot } from "./draft";
export { AuthenticationRequired, BuildMismatch, TransportError } from "./transport";
export type { RouteParams, RouteSearch, Transport } from "./transport";
export type { LayoutProps, LoadingProps } from "./route-tree";
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
  fetch?: typeof fetch;
  /** Replaces the HTTP/Flight transport. */
  transport?: Transport;
  initialPath?: string;
  /** Shown in the framework heading; the build passes the application directory name. */
  title?: string;
};

// TanStack scroll restoration calls the global scrollTo() after every rendered load.
// OpenTUI already installs a minimal global window; a terminal has no page to scroll.
function installTerminalGlobals() {
  const terminalGlobal = globalThis as { scrollTo?: () => void };
  terminalGlobal.scrollTo ??= () => {};
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
  readonly drafts = new DraftStore();
  readonly transport: Transport;
  // Typed per application through the generated `Register`, not here.
  readonly router: AnyRouter;
  status = "Connecting";
  error = "";
  private revision = 0;
  private listeners = new Set<() => void>();
  private purgeAfterLoad = false;
  constructor(readonly options: ApplicationOptions) {
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
        fetch: options.fetch,
        callServer: this.callServer,
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
    this.router.subscribe("onResolved", () => {
      if (!this.purgeAfterLoad) return;
      this.purgeAfterLoad = false;
      this.router.clearCache();
    });
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
  private report(status: string, error = "") {
    this.status = status;
    this.error = error;
    this.notify();
  }
  /**
   * Replaces the bearer for later requests and drops every cached private tree and
   * every Draft: another identity must not inherit them. `preserveDrafts` is for
   * renewing the bearer of the same identity.
   */
  setToken = (token?: string, options: { preserveDrafts?: boolean } = {}) => {
    this.transport.setToken(token);
    this.purge();
    if (!options.preserveDrafts) this.drafts.clear();
  };
  private purge() {
    this.router.clearCache();
    if (this.router.state.status === "pending") this.purgeAfterLoad = true;
  }
  /** Ctrl+R: revalidates the destination, or the mounted route, keeping it on failure. */
  refresh = () => this.router.invalidate();
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
    const mounted = refreshing
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
      if (e instanceof BuildMismatch) this.purge();
      if (e instanceof AuthenticationRequired && e.loginPath) {
        this.report(statusOf(e));
        throw redirect({ href: e.loginPath });
      }
      // A failed refresh keeps the mounted tree, its focus and its Drafts; a failed
      // navigation shows the error in the page slot, inside the persistent layouts.
      if (mounted !== undefined) {
        this.report(statusOf(e), (e as Error).message);
        return mounted as React.ReactNode;
      }
      this.report(statusOf(e));
      throw e;
    }
  }
  callServer = async (id: string, args: unknown[]) => {
    try {
      const value = await this.transport.call(id, args);
      this.report("Connected");
      // No automatic refresh: the code that mutates calls router.invalidate().
      return value;
    } catch (e) {
      if (e instanceof BuildMismatch) this.purge();
      if (e instanceof AuthenticationRequired && e.loginPath)
        void this.router.navigate({ href: e.loginPath });
      this.report(statusOf(e), (e as Error).message);
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
export function Shell({ app }: { app: Application }) {
  return (
    <Runtime.Provider value={app}>
      <RouterProvider router={app.router} />
    </Runtime.Provider>
  );
}
export function createApplication(options: ApplicationOptions) {
  return new Application(options);
}
export async function run(create: (options: Record<string, unknown>) => Application) {
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
  process.on("message", (message: { type?: string; message?: string } | null) => {
    if (message?.type === "build-error") {
      app.error = message.message ?? "Build failed";
      app.notify();
    }
  });
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const root = createRoot(renderer);
  // RouterProvider's Transitioner performs the initial load.
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
}
