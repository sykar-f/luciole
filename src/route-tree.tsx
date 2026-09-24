/** @jsxImportSource @opentui/react */
/**
 * Route factories used by the generated `app/routeTree.gen.ts`. The generated file
 * calls TanStack's `createRoute` with literal paths, so params, `to` and loader data
 * are typed from the application's own file tree.
 */
import { useEffect, useRef, type ReactNode } from "react";
import type { TextRenderable } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import { useBindings } from "@opentui/keymap/react";
import {
  Outlet,
  createRootRouteWithContext,
  useLoaderData,
  useParams,
  useRouter,
  useRouterState,
  type AnyRoute,
  type Router,
} from "@tanstack/react-router";
import { useApplication, useConnection, type Application } from "./client";
import { readNotFound } from "./not-found";
import { isReactNode, type RouteParams, type RouteSearch } from "./transport";

export type LayoutProps = { children: ReactNode; params: RouteParams };
export type LoadingProps = { path: string; params: RouteParams };
/**
 * Received by an `error.tsx` when its page failed to load or render. A transport failure
 * is a `TransportError` with its `outcome`; `retry()` loads the page again.
 */
export type ErrorProps = {
  error: unknown;
  path: string;
  params: RouteParams;
  retry: () => Promise<void>;
};
/** Received by a `not-found.tsx`; `what` is the argument the page gave `notFound()`. */
export type NotFoundProps = { path: string; params: RouteParams; what?: string };
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

// TanStack names the catch-all parameter `_splat`; the application names it `[...name]`.
const pick = (
  params: Record<string, string | undefined>,
  names: readonly string[],
  splat?: string,
) =>
  Object.fromEntries(
    names.map((name) => [name, (name === splat ? params._splat : params[name]) ?? ""]),
  );

function DefaultNotFound({ what }: { what?: string }) {
  return <text fg="#ffbc66">{what ? `${what} not found` : "Not found"}</text>;
}

export function rootRoute(
  Layout: ClientComponent<LayoutProps>,
  NotFound?: ClientComponent<NotFoundProps>,
) {
  return createRootRouteWithContext<TerminalRouterContext>()({
    component: () => (
      <Runtime>
        <Layout params={{}}>
          <Outlet />
        </Layout>
      </Runtime>
    ),
    notFoundComponent: function RouteNotFound() {
      const path = useRouterState({ select: (s) => s.location.pathname });
      return NotFound ? <NotFound path={path} params={{}} /> : <DefaultNotFound what="Route" />;
    },
  });
}

export function layoutRoute(Layout: ClientComponent<LayoutProps>, params: readonly string[]) {
  return {
    component: function LayoutRoute() {
      return (
        <Layout params={pick(useParams({ strict: false }), params)}>
          <Outlet />
        </Layout>
      );
    },
  };
}

type PageLoaderContext = {
  context: TerminalRouterContext;
  params: Readonly<Record<string, string | undefined>>;
  deps: { search: RouteSearch };
  abortController: AbortController;
  location: { href: string };
  route: { id: string };
  preload: boolean;
};

/**
 * Loader of every page route. The generated file calls it from an unannotated
 * `loader: (ctx) => loadPage(ctx, …)`: an annotated loader parameter would become an
 * inference site and widen the params TanStack derives from the literal path.
 */
export function loadPage(
  { context, params: all, deps, abortController, location, route, preload }: PageLoaderContext,
  routeId: string,
  params: readonly string[],
  splat?: string,
): Promise<ReactNode> {
  return context.app.renderPage(routeId, pick(all, params, splat), {
    signal: abortController.signal,
    href: location.href,
    route: route.id,
    search: deps.search,
    preload,
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

export function pageRoute(
  params: readonly string[],
  screens: {
    loading?: ClientComponent<LoadingProps>;
    error?: ClientComponent<ErrorProps>;
    notFound?: ClientComponent<NotFoundProps>;
    splat?: string;
  } = {},
) {
  const { loading: Loading, error: Failure, notFound: NotFound, splat } = screens;
  const usePageParams = () => pick(useParams({ strict: false }), params, splat);
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
      // The value `loadPage` resolved: a Flight tree the transport already checked.
      const tree: unknown = useLoaderData({ strict: false });
      if (!isReactNode(tree)) throw new Error("A page loader resolved with no React tree");
      return tree;
    },
    pendingComponent: function PageLoading() {
      const pageParams = usePageParams();
      const path = useRouterState({ select: (s) => s.location.pathname });
      const connected = useRouterState({ select: (s) => !!s.resolvedLocation });
      return Loading ? (
        <Loading path={path} params={pageParams} />
      ) : (
        <AnimatedLoading label={connected ? "Loading…" : "Connecting…"} />
      );
    },
    // Load failures and errors thrown while the streamed page renders both land here,
    // inside the persistent layouts.
    errorComponent: function PageError({ error }: { error: unknown }) {
      const router = useRouter();
      const pageParams = usePageParams();
      const path = useRouterState({ select: (s) => s.location.pathname });
      const missing = readNotFound(error);
      if (missing)
        return NotFound ? (
          <NotFound path={path} params={pageParams} what={missing.what} />
        ) : (
          <DefaultNotFound what={missing.what} />
        );
      if (Failure)
        return (
          <Failure
            error={error}
            path={path}
            params={pageParams}
            retry={() => router.invalidate()}
          />
        );
      return <text fg="#ffbc66">{error instanceof Error ? error.message : "Render failed"}</text>;
    },
  };
}

/** One fade of the loading label; the timeline fades out then back in. */
const PULSE_MS = 850;
function AnimatedLoading({ label }: { label: string }) {
  const target = useRef<TextRenderable>(null);
  const timeline = useTimeline({ autoplay: false, duration: PULSE_MS * 2, loop: true });
  useEffect(() => {
    if (!target.current) return;
    timeline.add(target.current, {
      duration: PULSE_MS,
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
    <text ref={target} id="airtty-loading" height={1} flexShrink={0} wrapMode="none" truncate>
      {label}
    </text>
  );
}

/**
 * The only behaviour the framework adds around the root layout: Escape abandons a
 * pending navigation, and a development build failure stays visible. Status, help
 * and refresh keys belong to the application's own chrome (`useConnection`).
 */
function Runtime({ children }: { children: ReactNode }) {
  const app = useApplication();
  const { activity, buildError } = useConnection();
  // The framework's only layer (`group: "airtty"`). Ctrl+C also works without React: run()
  // listens to the renderer directly. Escape still reaches the application's bindings.
  useBindings(
    () => ({
      bindings: [
        { key: "ctrl+c", cmd: () => app.quit?.(), desc: "quit", group: "airtty" },
        ...(activity === "navigate"
          ? [
              {
                key: "escape",
                cmd: app.cancel,
                desc: "cancel",
                group: "airtty",
                preventDefault: false,
                fallthrough: true,
              },
            ]
          : []),
      ],
    }),
    [activity, app],
  );
  return (
    <box flexDirection="column" flexGrow={1}>
      {buildError ? (
        <text id="airtty-build-error" flexShrink={0} fg="#ffbc66">
          {buildError}
        </text>
      ) : null}
      {children}
    </box>
  );
}
