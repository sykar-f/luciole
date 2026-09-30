/** @jsxImportSource @opentui/react */
// Inline embedding probe: two real applications (examples/mdreader and examples/files)
// in one Client process, one React tree, one renderer. First as src/ allows today, to
// measure the obstacles; then with the refactor of docs/EMBEDDING.md done from outside
// src/ (probes/generic-client/host.tsx). `bun probes/inline/probe.tsx` from the root.
import { act, useSyncExternalStore } from "react";
import { testRender } from "@opentui/react/test-utils";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, until, type TestUI } from "../../tests/helpers";
import type { Application, ApplicationEvent } from "../../packages/luciole/src/client";
import { messageOf } from "../../packages/luciole/src/guards";
import type { AbiSpecifier } from "../generic-client/abi";
import { bundleApp, type AppBundle } from "../generic-client/bundle";
import { EmbedShell, createPanes } from "../generic-client/host";
import { evaluateBundle, type LoadedBundle } from "../generic-client/loader";
import { abiModules, loadRuntime, type Runtime } from "../generic-client/runtime";

const WIDTH = 160;
const HEIGHT = 30;
const SETTLE_MS = 600;
const RENDER_TIMEOUT_MS = 10_000;
const MB = 1_048_576;
const FRAME_LINES = 12;
const PRECISION = 10;
const round = (n: number) => Math.round(n * PRECISION) / PRECISION;
const results: Record<string, unknown> = {};
const assertions: { scenario: string; name: string; ok: boolean; detail?: string }[] = [];
const check = (scenario: string, name: string, ok: boolean, detail?: string) => {
  assertions.push({ scenario, name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} [${scenario}] ${name}${detail ? ` — ${detail}` : ""}`);
};

// A host-owned component that throws on demand, inside one embed.
let armed = false;
const bombListeners = new Set<() => void>();
const arm = () => {
  armed = true;
  for (const l of bombListeners) l();
};
function Bomb() {
  const boom = useSyncExternalStore(
    (l) => {
      bombListeners.add(l);
      return () => bombListeners.delete(l);
    },
    () => armed,
  );
  if (boom) throw new Error("host-injected crash");
  return null;
}

/** Everything one Application did, for attribution. */
function record(app: Application) {
  const events: ApplicationEvent[] = [];
  app.onEvent((e) => events.push(e));
  return {
    events,
    actions: () =>
      events
        .filter((e) => e.type === "request" && e.kind === "action")
        .map((e) => ("target" in e ? e.target : "")),
    navigations: () => events.filter((e) => e.type === "navigation").length,
    refreshes: () =>
      events.filter((e) => e.type === "loader" && e.phase === "start" && e.cause === "refresh")
        .length,
    loadErrors: () =>
      app.router.state.matches.flatMap((m) => (m.status === "error" ? [messageOf(m.error)] : [])),
  };
}
async function frameOf(ui: TestUI) {
  await ui.renderOnce();
  return ui.captureCharFrame();
}
async function settle(ui: TestUI) {
  await act(async () => {
    await Bun.sleep(SETTLE_MS);
  });
  return frameOf(ui);
}
const buildOf = (id: string) => id.split("/")[0] ?? "";

const docs = await mkdtemp(join(tmpdir(), "luciole-inline-docs-"));
const otherDocs = await mkdtemp(join(tmpdir(), "luciole-inline-docs-"));
await Bun.write(join(otherDocs, "README.md"), "# Second pane\n\nServed by another mdreader.\n");
const files = await mkdtemp(join(tmpdir(), "luciole-inline-files-"));
await Bun.write(join(docs, "README.md"), "# Handbook\n\nRendered by mdreader, inline.\n");
await Bun.write(join(docs, "guide.md"), "# Guide\n\nThe next document.\n");
await Bun.write(join(files, "alpha-inline.txt"), "alpha\n");
await Bun.write(join(files, "beta-inline.txt"), "beta\n");
const md = { dir: resolve("examples/mdreader"), env: { MD_PATH: docs } };
const fx = { dir: resolve("examples/files"), env: { FILES_ROOT: files } };
const bundles: Record<string, AppBundle> = {
  mdreader: await bundleApp(md.dir),
  files: await bundleApp(fx.dir),
};
// Servers with the proposed instance prefix (instance-server.ts); a request without
// `x-luciole-instance`, as in `today`, gets the ids src/server.ts writes now.
const start = (dir: string, env: Record<string, string>) =>
  launch(join(import.meta.dir, "instance-server.ts"), {
    SERVER_ENTRY: join(dir, ".luciole/server/index.js"),
    ...env,
  });
const servers = {
  mdreader: await start(md.dir, md.env),
  files: await start(fx.dir, fx.env),
  // A second Server of the same build: the multiplexer's two panes of one application.
  mdreader2: await start(md.dir, { MD_PATH: otherDocs }),
};
const { runtime } = await loadRuntime();
results.bundles = Object.fromEntries(
  Object.entries(bundles).map(([name, b]) => [
    name,
    {
      buildId: b.buildId,
      bytes: Buffer.byteLength(b.code),
      clientModules: b.clientModules,
      builtins: b.builtins,
    },
  ]),
);
check(
  "audit",
  "Node built-ins a Client bundle needs are found at bundle time",
  bundles.files?.builtins.includes("fs/promises") === true,
  `files: ${bundles.files?.builtins.join(", ")}`,
);

function evaluate(name: "mdreader" | "files", abi: (s: AbiSpecifier) => unknown): LoadedBundle {
  const b = bundles[name];
  if (!b) throw new Error(name);
  return evaluateBundle(b.code, { filename: `luciole-app:${name}`, abi, builtins: b.builtins });
}

/** Today: each Application with its own resolver, imported actions through `current`. */
async function today(rt: Runtime) {
  const base = abiModules(rt);
  const mdBundle = evaluate("mdreader", (s) => base[s]);
  const fxBundle = evaluate("files", (s) => base[s]);
  const create = (b: LoadedBundle, url: string) =>
    rt.lucioleClient.createApplication({
      url,
      routeTree: b.routeTree,
      buildId: b.buildId,
      // What the generated createApp of src/build.ts passes: this bundle's modules only.
      resolveModule: (id) => {
        const m = b.modules.get(id);
        if (!m) throw new Error(`Unknown module ${id}`);
        return m;
      },
    });
  const mdApp = create(mdBundle, servers.mdreader.url);
  const fxApp = create(fxBundle, servers.files.url);
  const mdLog = record(mdApp);
  const fxLog = record(fxApp);
  const { Shell } = rt.lucioleClient;
  const ui = await testRender(
    <box flexDirection="row" flexGrow={1}>
      <box flexGrow={1} flexBasis={0}>
        <Shell app={mdApp} />
      </box>
      <box flexGrow={1} flexBasis={0}>
        <Shell app={fxApp} />
        <Bomb />
      </box>
    </box>,
    { width: WIDTH, height: HEIGHT },
  );
  let frame = await settle(ui);
  const S = "today";
  // Flight resolves Client References lazily, while React renders the tree: the loader
  // succeeded and the page's error screen caught the failure.
  const unknown = frame.split("\n").find((l) => l.includes("Unknown module"));
  check(
    S,
    "mdreader's page cannot resolve its Client modules (files' resolver won)",
    unknown !== undefined,
    unknown?.trim(),
  );
  check(S, "files, created last, renders", frame.includes("alpha-inline.txt"));
  const foreign = fxLog.actions().filter((t) => buildOf(t) === mdBundle.buildId);
  check(
    S,
    "mdreader's imported watchLibrary() is sent through files' Application",
    foreign.length > 0,
    foreign[0],
  );
  await act(async () => {
    ui.mockInput.pressKey("r", { ctrl: true });
    await Bun.sleep(SETTLE_MS);
  });
  check(
    S,
    "Ctrl+R, bound by both, reaches only the keymap created last (files)",
    fxLog.refreshes() > 0 && mdLog.refreshes() === 0,
    `mdreader ${mdLog.refreshes()}, files ${fxLog.refreshes()}`,
  );
  await act(async () => {
    arm();
    await Bun.sleep(SETTLE_MS);
  });
  frame = await frameOf(ui);
  check(
    S,
    "a crash inside files' embed blanks mdreader too",
    !frame.includes("MDREADER") && !frame.includes("alpha-inline.txt"),
  );
  results.today = {
    frameAfterCrash:
      frame.trim().length === 0 ? "(empty)" : frame.split("\n").slice(0, FRAME_LINES).join("\n"),
  };
  await act(async () => ui.renderer.destroy());
}

/** Proposed: one module router, per-origin actionReference, scoped keymaps, boundaries. */
async function proposed(rt: Runtime) {
  armed = false;
  const panes = createPanes(rt, { routeBy: "instance" });
  const rss0 = process.memoryUsage().rss;
  let t = performance.now();
  const mdKey = panes.open(bundles.mdreader?.buildId ?? "");
  const mdBundle = evaluate("mdreader", panes.abiFor(mdKey));
  const mdApp = panes.mount(mdKey, mdBundle, { url: servers.mdreader.url });
  const firstMs = performance.now() - t;
  t = performance.now();
  const fxKey = panes.open(bundles.files?.buildId ?? "");
  const fxBundle = evaluate("files", panes.abiFor(fxKey));
  const fxApp = panes.mount(fxKey, fxBundle, { url: servers.files.url });
  const secondMs = performance.now() - t;
  const mdLog = record(mdApp);
  const fxLog = record(fxApp);
  // "both": every embed hears every key, as with today's Shell.
  let active = "both";
  const activeListeners = new Set<() => void>();
  const focus = (name: string) => {
    active = name;
    for (const l of activeListeners) l();
  };
  function Host() {
    const current = useSyncExternalStore(
      (l) => {
        activeListeners.add(l);
        return () => activeListeners.delete(l);
      },
      () => active,
    );
    return (
      <box flexDirection="row" flexGrow={1}>
        <EmbedShell
          runtime={rt}
          app={mdApp}
          name="mdreader"
          active={current === "mdreader" || current === "both"}
        />
        <EmbedShell
          runtime={rt}
          app={fxApp}
          name="files"
          active={current === "files" || current === "both"}
        >
          <Bomb />
        </EmbedShell>
      </box>
    );
  }
  const ui = await testRender(<Host />, { width: WIDTH, height: HEIGHT });
  const S = "proposed";
  let frame = "";
  await act(async () => {
    await until(() => {
      void ui.renderOnce();
      frame = ui.captureCharFrame();
      return frame.includes("Rendered by mdreader, inline.") && frame.includes("alpha-inline.txt");
    }, RENDER_TIMEOUT_MS);
  });
  const rss2 = process.memoryUsage().rss;
  check(S, "both applications render side by side", true);
  results.frame = frame.split("\n").slice(0, FRAME_LINES).join("\n");
  const mdOwn = mdLog.actions();
  check(
    S,
    "mdreader's imported Server Functions go to mdreader's Server",
    mdOwn.length > 0 && mdOwn.every((a) => buildOf(a) === mdBundle.buildId),
    mdOwn.join(", "),
  );
  check(
    S,
    "files' Application sends no foreign action",
    fxLog.actions().every((a) => buildOf(a) === fxBundle.buildId),
  );
  // README.md is the second of two documents: `[` opens guide.md, `]` README.md again.
  const initial = mdLog.navigations();
  await act(async () => {
    ui.mockInput.pressKey("[");
    await Bun.sleep(SETTLE_MS);
  });
  check(
    "today",
    "unscoped keymaps: `[`, bound by mdreader only, reaches it whatever pane the user is in",
    mdLog.navigations() > initial,
  );
  await act(async () => {
    focus("files");
    await Bun.sleep(SETTLE_MS);
  });
  const before = { md: mdLog.refreshes(), fx: fxLog.refreshes() };
  await act(async () => {
    ui.mockInput.pressKey("r", { ctrl: true });
    await Bun.sleep(SETTLE_MS);
  });
  check(
    S,
    "Ctrl+R refreshes the active embed (files) only",
    fxLog.refreshes() > before.fx && mdLog.refreshes() === before.md,
    `mdreader +${mdLog.refreshes() - before.md}, files +${fxLog.refreshes() - before.fx}`,
  );
  await act(async () => {
    focus("mdreader");
    await Bun.sleep(SETTLE_MS);
    ui.mockInput.pressKey("r", { ctrl: true });
    await Bun.sleep(SETTLE_MS);
  });
  check(
    S,
    "after switching, Ctrl+R refreshes mdreader only",
    mdLog.refreshes() > before.md && fxLog.refreshes() === before.fx + 1,
  );
  await act(async () => {
    focus("files");
    await Bun.sleep(SETTLE_MS);
  });
  const navigations = mdLog.navigations();
  await act(async () => {
    ui.mockInput.pressKey("]");
    await Bun.sleep(SETTLE_MS);
  });
  check(
    S,
    "`]` does not reach mdreader while files has the keys",
    mdLog.navigations() === navigations,
  );
  await act(async () => {
    focus("mdreader");
    await Bun.sleep(SETTLE_MS);
    ui.mockInput.pressKey("]");
    await Bun.sleep(SETTLE_MS);
  });
  check(
    S,
    "`]` opens mdreader's next document once it has the keys",
    mdLog.navigations() > navigations,
  );
  const focused = ui.renderer.currentFocusedRenderable;
  results.focusedAfterMount = focused ? `${focused.id} (${focused.constructor.name})` : null;
  await act(async () => {
    arm();
    await Bun.sleep(SETTLE_MS);
  });
  frame = await frameOf(ui);
  check(
    S,
    "a crash in files' embed leaves mdreader running",
    frame.includes("MDREADER") && frame.includes("files crashed"),
  );
  results.proposed = {
    evaluateAndMountMs: { first: round(firstMs), second: round(secondMs) },
    rssMB: {
      beforeRender: round(rss0 / MB),
      afterBothRendered: round(rss2 / MB),
      note: "includes the test renderer's buffers",
    },
    frameAfterCrash: frame.split("\n").slice(0, FRAME_LINES).join("\n"),
  };
  await act(async () => ui.renderer.destroy());
}

/**
 * Two panes of one application (one build), each against its own Server: keyed by build
 * ID, the panes share one entry; keyed by instance (decided), each keeps its modules and
 * its Application.
 */
async function samePanes(rt: Runtime, routeBy: "build" | "instance") {
  const panes = createPanes(rt, { routeBy });
  const S = `panes/${routeBy}`;
  const open = (url: string) => {
    const key = panes.open(bundles.mdreader?.buildId ?? "");
    const loaded = evaluate("mdreader", panes.abiFor(key));
    // Counts the Client References this pane's own module instance resolved.
    let resolved = 0;
    const modules = new Map(loaded.modules);
    const get = modules.get.bind(modules);
    modules.get = (id) => {
      resolved++;
      return get(id);
    };
    const app = panes.mount(key, { ...loaded, modules }, { url });
    return { app, log: record(app), resolved: () => resolved };
  };
  const a = open(servers.mdreader.url);
  const b = open(servers.mdreader2.url);
  const ui = await testRender(
    <box flexDirection="row" flexGrow={1}>
      <EmbedShell runtime={rt} app={a.app} name="a" active />
      <EmbedShell runtime={rt} app={b.app} name="b" active={false} />
    </box>,
    { width: WIDTH, height: HEIGHT },
  );
  const frame = await settle(ui);
  const both =
    frame.includes("Rendered by mdreader, inline.") &&
    frame.includes("Served by another mdreader.");
  const counts = `pane a resolved ${a.resolved()}, pane b ${b.resolved()}`;
  const actions = `pane a sent ${a.log.actions().length} actions, pane b ${b.log.actions().length}`;
  if (routeBy === "build") {
    check(
      S,
      "pane a's Client References are resolved with pane b's module instance",
      a.resolved() === 0 && b.resolved() > 0,
      counts,
    );
    check(
      S,
      "pane a's imported Server Functions leave through pane b's Application",
      a.log.actions().length === 0 && b.log.actions().length > 1,
      actions,
    );
  } else {
    check(S, "each pane renders its own Server's document", both);
    check(
      S,
      "each pane resolves with its own module instance",
      a.resolved() > 0 && b.resolved() > 0,
      counts,
    );
    check(
      S,
      "each pane's imported Server Functions use its own Application",
      a.log.actions().length > 0 && b.log.actions().length > 0,
      actions,
    );
  }
  results[S] = {
    resolved: { a: a.resolved(), b: b.resolved() },
    actions: { a: a.log.actions().length, b: b.log.actions().length },
  };
  await act(async () => ui.renderer.destroy());
}

try {
  await today(runtime);
  await proposed(runtime);
  await samePanes(runtime, "build");
  await samePanes(runtime, "instance");
} finally {
  await servers.mdreader.stop();
  await servers.mdreader2.stop();
  await servers.files.stop();
  await rm(otherDocs, { recursive: true, force: true });
  await rm(docs, { recursive: true, force: true });
  await rm(files, { recursive: true, force: true });
}
results.assertions = assertions;
results.ranAt = new Date().toISOString();
results.bun = Bun.version;
await Bun.write(join(import.meta.dir, "results.json"), JSON.stringify(results, null, 2) + "\n");
const failed = assertions.filter((a) => !a.ok);
console.log(failed.length ? `${failed.length} assertion(s) failed` : "all assertions passed");
process.exit(failed.length ? 1 : 0);
