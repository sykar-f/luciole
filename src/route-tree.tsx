/** @jsxImportSource @opentui/react */
/**
 * Route factories used by the generated `app/routeTree.gen.ts`. The generated file
 * calls TanStack's `createRoute` with literal paths, so params, `to` and loader data
 * are typed from the application's own file tree.
 */
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { useKeyboard, useTimeline } from "@opentui/react";
import {
  Outlet,
  createRootRouteWithContext,
  useLoaderData,
  useParams,
  useRouterState,
  type AnyRoute,
  type Router,
} from "@tanstack/react-router";
import { useApplication, type Application } from "./client";
import type { RouteParams, RouteSearch } from "./transport";

export type LayoutProps = { children: ReactNode; params: RouteParams };
export type LoadingProps = { path: string; params: RouteParams };
/** Layouts and loadings are synchronous Client function components. */
type ClientComponent<P> = (props: P) => ReactNode;
export type TerminalRouterContext = { app: Application };
export type TerminalRouter<TRouteTree extends AnyRoute> = Router<TRouteTree>;

declare module "@tanstack/history" {
  interface HistoryState {
    /** Set by Escape: show the resolved route again without refetching it. */
    terminalRestore?: boolean;
  }
}

const pick = (params: Record<string, string | undefined>, names: readonly string[]) =>
  Object.fromEntries(names.map((name) => [name, params[name] ?? ""]));

export function rootRoute(Layout: ClientComponent<LayoutProps>) {
  return createRootRouteWithContext<TerminalRouterContext>()({
    component: () => (
      <Frame>
        <Layout params={{}}>
          <Outlet />
        </Layout>
      </Frame>
    ),
    notFoundComponent: () => <text fg="#ffbc66">Route not found</text>,
  });
}

export function layoutRoute(Layout: ClientComponent<LayoutProps>, params: readonly string[]) {
  return {
    component: function LayoutRoute() {
      const all = useParams({ strict: false }) as Record<string, string | undefined>;
      return (
        <Layout params={pick(all, params)}>
          <Outlet />
        </Layout>
      );
    },
  };
}

type PageLoaderContext = {
  context: TerminalRouterContext;
  params: object;
  deps: { search: RouteSearch };
  abortController: AbortController;
  location: { href: string };
  route: { id: string };
};

/**
 * Loader of every page route. The generated file calls it from an unannotated
 * `loader: (ctx) => loadPage(ctx, …)`: an annotated loader parameter would become an
 * inference site and widen the params TanStack derives from the literal path.
 */
export function loadPage(
  { context, params: all, deps, abortController, location, route }: PageLoaderContext,
  routeId: string,
  params: readonly string[],
): Promise<ReactNode> {
  return context.app.renderPage(routeId, pick(all as Record<string, string>, params), {
    signal: abortController.signal,
    href: location.href,
    route: route.id,
    search: deps.search,
  });
}

/**
 * Search values are strings: anything else in a location is dropped, never trusted.
 * Every key is optional, so navigating without `search` stays valid.
 */
export function validateSearch(raw: Record<string, unknown>): Partial<RouteSearch> {
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}
const definedSearch = (search: Partial<RouteSearch>): RouteSearch =>
  Object.fromEntries(
    Object.entries(search).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

export function pageRoute(params: readonly string[], Loading?: ClientComponent<LoadingProps>) {
  return {
    validateSearch,
    // A new search is a new page: the Server renders it and TanStack caches it apart.
    loaderDeps: ({ search }: { search: Partial<RouteSearch> }) => ({
      search: definedSearch(search),
    }),
    // Escape restores the resolved route from its committed match; otherwise TanStack's
    // own staleness rules apply.
    shouldReload: ({ location }: { location: { state: { terminalRestore?: boolean } } }) =>
      location.state.terminalRestore ? false : undefined,
    component: function Page(): ReactNode {
      return useLoaderData({ strict: false }) as ReactNode;
    },
    pendingComponent: function PageLoading() {
      const all = useParams({ strict: false }) as Record<string, string | undefined>;
      const path = useRouterState({ select: (s) => s.location.pathname });
      const connected = useRouterState({ select: (s) => !!s.resolvedLocation });
      return Loading ? (
        <Loading path={path} params={pick(all, params)} />
      ) : (
        <AnimatedLoading label={connected ? "Loading…" : "Connecting…"} />
      );
    },
    errorComponent: ({ error }: { error: unknown }) => (
      <text fg="#ffbc66">
        {error instanceof Error ? error.message : "Render failed"} · Ctrl+R to retry
      </text>
    ),
  };
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

/** Framework chrome around the application's root layout: status, shortcuts, errors. */
function Frame({ children }: { children: ReactNode }) {
  const app = useApplication();
  useSyncExternalStore(app.subscribe, app.snapshot);
  // A navigation changes the location; a refresh reloads the resolved one in the
  // background, visible only as fetching matches.
  const activity = useRouterState({
    select: (s) =>
      s.resolvedLocation && s.resolvedLocation.href !== s.location.href
        ? "navigate"
        : !s.resolvedLocation
          ? "connect"
          : s.status === "pending" || s.matches.some((m) => m.isFetching)
            ? "refresh"
            : "idle",
  });
  useKeyboard((key) => {
    if (key.ctrl && key.name === "r") void app.refresh();
    if (key.name === "escape" && activity === "navigate") app.cancel();
  });
  return (
    <box flexDirection="column" flexGrow={1} padding={1} gap={1}>
      <text id="terminal-heading" height={1} flexShrink={0} wrapMode="none" truncate fg="#67d9bc">
        TERMINAL / {app.options.title ?? "APP"} · {app.status}
        {activity === "refresh" ? " · Refreshing…" : ""}
        {activity === "navigate" ? " · Esc cancel" : ""}
      </text>
      {app.error ? <text fg="#ffbc66">{app.error}</text> : null}
      {children}
      <text id="terminal-footer" height={1} flexShrink={0} wrapMode="none" truncate fg="#8b98a5">
        Ctrl+R reconnect · Ctrl+C quit
      </text>
    </box>
  );
}
