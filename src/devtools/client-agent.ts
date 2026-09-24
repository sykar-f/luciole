import { setTimeout as delay } from "node:timers/promises";
import type { CliRenderer } from "@opentui/core";
import type { Application, ApplicationEvent } from "../client";
import { messageOf } from "../guards";
import type { Transport } from "../transport";
import { createComponentTracker, fiberChannel } from "./fibers";
import { createOverlay } from "./overlay";
import { captureConsole, consoleText, preview } from "./preview";
import { message, parseAddress, PLUGIN, PROTOCOL_VERSION } from "./protocol";
import { parseCommand, type Command, type RouterMatch } from "./schema";
import { connectAgent } from "./wire";

/**
 * The Client's side of `airtty devtools`, started by `run()` when `AIRTTY_DEVTOOLS` is set.
 * It streams the application's events, router state, console calls, key presses and
 * component commits, and obeys the DevTools' commands (invalidate, network conditions,
 * paint flashing). It only observes, through the runtime's public seams (`onEvent`,
 * `wrapTransport`, the router, the renderer), except for the fiber hook (hook.ts).
 */
const now = () => performance.timeOrigin + performance.now();
const ROUTER_THROTTLE_MS = 100;
const COMPONENTS_THROTTLE_MS = 200;
// OpenTUI replaces the global console when its capture activates: checked this often.
const CONSOLE_CHECK_MS = 1000;

/** A match as the Router panel shows it; `loaderData` is a Flight tree, only named. */
type Match = {
  id: string;
  routeId: string;
  pathname: string;
  status: string;
  isFetching: boolean | string;
  invalid?: boolean;
  preload?: boolean;
  updatedAt?: number;
  params?: unknown;
  search?: unknown;
  loaderData?: unknown;
  error?: unknown;
};
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, preview(v)]))
    : undefined;
const describeMatch = (match: Match): RouterMatch => ({
  id: match.id,
  routeId: match.routeId,
  pathname: match.pathname,
  status: match.status,
  isFetching: match.isFetching,
  invalid: match.invalid,
  preload: match.preload,
  updatedAt: match.updatedAt,
  params: record(match.params),
  search: record(match.search),
  loaderData: match.loaderData === undefined ? undefined : preview(match.loaderData),
  error: match.error === undefined || match.error === null ? undefined : messageOf(match.error),
});

export type ClientAgent = {
  /** Passed to `createApplication` as `wrapTransport`: live latency, added before sending. */
  wrapTransport: (inner: Transport) => Transport;
  /** Starts observing, once the application and its renderer exist. */
  attach: (app: Application, renderer: CliRenderer) => void;
};

/** `undefined` in production: the DevTools are a development tool. */
export function startClientAgent({
  address,
  name,
}: {
  address: string;
  name?: string;
}): ClientAgent | undefined {
  if (process.env.NODE_ENV === "production") {
    console.error("AIRTTY_DEVTOOLS is ignored in production");
    return undefined;
  }
  const channel = fiberChannel();
  let onCommand: (command: Command) => void = () => {};
  const agent = connectAgent({
    address: parseAddress(address),
    hello: {
      protocol: PROTOCOL_VERSION,
      role: "client",
      pid: process.pid,
      app: name,
      components: channel !== undefined,
    },
    onCommand: (value) => {
      const command = parseCommand(value);
      if (command) onCommand(command);
    },
  });
  let latencyMs = 0;
  // Added before the request is sent: the Network panel shows it as the loader's wait.
  // Cancelled meanwhile, the request goes on to the transport with its aborted signal,
  // which fails it as not sent, with the transport's own error. (Importing the
  // transport here would put Flight's top-level await in this lazily loaded chunk.)
  const wait = async (signal: AbortSignal | undefined) => {
    if (latencyMs) await delay(latencyMs, undefined, { signal }).catch(() => {});
  };
  const wrapTransport = (inner: Transport): Transport => ({
    async render(routeId, params, signal, search, context) {
      await wait(signal);
      return inner.render(routeId, params, signal, search, context);
    },
    async call(actionId, args, signal, context) {
      await wait(signal);
      return inner.call(actionId, args, signal, context);
    },
    setToken: (token) => inner.setToken(token),
  });

  function attach(app: Application, renderer: CliRenderer) {
    const send = (plugin: (typeof PLUGIN)[keyof typeof PLUGIN], suffix: string, payload: unknown) =>
      agent.send(message(plugin, suffix, payload));
    const throttle = (ms: number, run: () => void) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return () => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = undefined;
          run();
        }, ms);
        timer.unref();
      };
    };

    // Router: state after each change, and navigations TanStack answered from its cache.
    const router = app.router;
    const sendRouter = () => {
      const state = router.state;
      send(PLUGIN.router, "state", {
        at: now(),
        status: state.status,
        href: state.location.href,
        resolvedHref: state.resolvedLocation?.href,
        matches: state.matches.map(describeMatch),
        cached: [...router._cache.values()].map(describeMatch),
      });
    };
    const routerChanged = throttle(ROUTER_THROTTLE_MS, sendRouter);
    for (const event of ["onBeforeNavigate", "onBeforeLoad", "onLoad", "onResolved"] as const)
      router.subscribe(event, routerChanged);

    // A resolved navigation whose page no loader fetched came from TanStack's cache:
    // Chrome's "(memory cache)" row. feat/use-cache may report it itself (`source`); then
    // synthesizing stops.
    const loaded = new Set<string>();
    const routeOfHref = new Map<string, string>();
    const preloaded = new Set<string>();
    let native = false;
    const observe = (event: ApplicationEvent) => {
      send(PLUGIN.client, event.type, event);
      if (event.type === "loader") {
        if ("source" in event) native = true;
        routeOfHref.set(event.href, event.routeId);
        if (event.phase === "start") {
          loaded.add(event.href);
          if (event.cause === "preload") preloaded.add(event.href);
        }
      }
      if (event.type === "loader" || event.type === "invalidate" || event.type === "navigation")
        routerChanged();
    };
    app.onEvent(observe);
    router.subscribe("onBeforeNavigate", () => loaded.clear());
    router.subscribe("onResolved", ({ toLocation }: { toLocation: { href: string } }) => {
      const href = toLocation.href;
      const routeId = routeOfHref.get(href);
      if (native || loaded.has(href) || !routeId) return;
      send(PLUGIN.client, "loader", {
        type: "loader",
        at: now(),
        phase: "end",
        routeId,
        href,
        cause: preloaded.has(href) ? "preload" : "navigation",
        ms: 0,
        result: "ok",
        source: "router-cache",
        synthetic: true,
      });
    });

    // Console: the TUI owns stdout, so this is the only place Client logs are readable.
    let console = captureConsole((level, args) =>
      send(PLUGIN.console, "entry", { at: now(), level, text: consoleText(args) }),
    );
    setInterval(() => {
      if (globalThis.console === console.target) return;
      console = captureConsole((level, args) =>
        send(PLUGIN.console, "entry", { at: now(), level, text: consoleText(args) }),
      );
    }, CONSOLE_CHECK_MS).unref();

    renderer.keyInput.on("keypress", (key) =>
      send(PLUGIN.input, "key", {
        at: now(),
        name: key.name,
        sequence: key.sequence,
        ctrl: key.ctrl,
        meta: key.meta,
        shift: key.shift,
      }),
    );

    // Components: every commit counts renders and flashes; the tree follows, throttled.
    const overlay = createOverlay(renderer);
    const tracker = createComponentTracker(now);
    let lastRoot: unknown;
    const flashed = new Set<number>();
    const sendComponents = () => {
      if (lastRoot === undefined) return;
      send(PLUGIN.components, "commit", {
        at: now(),
        nodes: tracker.describe(lastRoot),
        flashed: [...flashed],
      });
      flashed.clear();
    };
    const componentsChanged = throttle(COMPONENTS_THROTTLE_MS, sendComponents);
    if (channel) {
      const onCommit = (root: unknown) => {
        lastRoot = root;
        const rendered = tracker.onCommit(root);
        for (const item of rendered) flashed.add(item.id);
        overlay.flash(rendered);
        componentsChanged();
      };
      for (const root of channel.roots) onCommit(root);
      channel.subscribe(onCommit);
    } else
      send(PLUGIN.components, "unavailable", {
        reason:
          "The fiber hook was not preloaded: start the Client with BUN_OPTIONS=--preload=<airtty>/src/devtools/hook.ts (airtty devtools prints the line).",
      });

    onCommand = (command) => {
      switch (command.suffix) {
        case "invalidate":
          void app.invalidate(command.payload.paths).catch(() => {});
          return;
        case "refresh":
          void app.refresh().catch(() => {});
          return;
        case "network": {
          const { latencyMs: latency, jitterMs, chunkDelayMs, faults } = command.payload;
          if (latency !== undefined) latencyMs = latency;
          // The HTTP transport reads these on every request: changed in place, they apply
          // to the next one. `AIRTTY_LATENCY_MS` itself is fixed at startup.
          const network = app.options.network;
          if (!network) return;
          if (jitterMs !== undefined) network.jitterMs = jitterMs;
          if (chunkDelayMs !== undefined) network.chunkDelayMs = chunkDelayMs;
          if (faults !== undefined)
            network.fault = faults.length
              ? () => faults.find(({ p }) => Math.random() < p)?.type
              : undefined;
          return;
        }
        case "highlight":
          overlay.configure(command.payload);
          return;
        case "select":
          overlay.select(
            command.payload.id === null || lastRoot === undefined
              ? undefined
              : tracker.rectById(lastRoot, command.payload.id),
          );
          return;
        case "snapshot":
          sendRouter();
          sendComponents();
          return;
      }
    };
    sendRouter();
  }
  return { wrapTransport, attach };
}
