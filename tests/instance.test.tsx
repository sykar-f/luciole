/** @jsxImportSource @opentui/react */
import { test, expect } from "bun:test";
import { act, useState, type ReactNode } from "react";
import { useRenderer } from "@opentui/react";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider } from "@opentui/keymap/react";
import { testRender } from "@opentui/react/test-utils";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../src/build";
import { createRootRoute } from "@tanstack/react-router";
import {
  Embed,
  createActions,
  createApplication,
  openApplication,
  type Application,
  type ApplicationEvent,
  type Transport,
} from "../src/client";
import { registerModules, splitInstance } from "../src/flight/client";
import { instanceManifests } from "../src/instance";
import { destroy, importClient, launch, readManifest, until, type TestUI } from "./helpers";

test("an instance key is read before the build ID's slash only", () => {
  expect(splitInstance("p1@abc/app/x.tsx")).toEqual(["p1", "abc/app/x.tsx"]);
  expect(splitInstance("abc/app/x.tsx")).toEqual(["", "abc/app/x.tsx"]);
  expect(splitInstance("abc/node_modules/@scope/pkg/x.js")).toEqual([
    "",
    "abc/node_modules/@scope/pkg/x.js",
  ]);
});

test("registered resolvers are chosen by key; unregistering keeps a newer one", () => {
  const first = registerModules("t-reg", () => ({ from: "first" }));
  const second = registerModules("t-reg", () => ({ from: "second" }));
  expect(globalThis.__webpack_require__("t-reg@b/x")).toEqual({ from: "second" });
  first();
  expect(globalThis.__webpack_require__("t-reg@b/x")).toEqual({ from: "second" });
  second();
  expect(() => globalThis.__webpack_require__("t-reg@b/x")).toThrow("Unknown Client module");
});

test("instance manifests prefix ids, keep the base and stay bounded", () => {
  const base = { "b/x.tsx#X": { id: "b/x.tsx", chunks: [], name: "X" } };
  const manifestFor = instanceManifests(base);
  expect(manifestFor(undefined)).toBe(base);
  const p1 = manifestFor("p1");
  expect(p1).toEqual({ "b/x.tsx#X": { id: "p1@b/x.tsx", chunks: [], name: "X" } });
  expect(manifestFor("p1")).toBe(p1);
  for (let i = 0; i < 64; i++) manifestFor(`k${i}`);
  // 64 newer keys pushed p1 out: it is copied again.
  expect(manifestFor("p1")).not.toBe(p1);
});

test("one runtime, two bundle bindings: imported Server Functions reach their own pane", async () => {
  // The generic Client shares one runtime between the bundles of several panes: nothing
  // process-wide may choose the Application (the former \`current\`).
  const calls: string[] = [];
  const pane = (name: string) => {
    const transport: Transport = {
      render: () => Promise.reject(new Error("no pages here")),
      call: (id) => {
        calls.push(`${name}:${id}`);
        return Promise.resolve(name);
      },
      setToken: () => {},
    };
    const actions = createActions();
    const app = createApplication({
      url: "http://127.0.0.1:1",
      buildId: "b",
      resolveModule: () => ({}),
      routeTree: createRootRoute(),
      transport,
      instance: name,
    });
    actions.bind(app);
    return actions.reference("b/actions/save.ts#save");
  };
  const saveA = pane("pa");
  const saveB = pane("pb");
  expect(await saveA()).toBe("pa");
  expect(await saveB()).toBe("pb");
  expect(await saveA()).toBe("pa");
  expect(calls).toEqual([
    "pa:b/actions/save.ts#save",
    "pb:b/actions/save.ts#save",
    "pa:b/actions/save.ts#save",
  ]);
  expect(() =>
    createApplication({
      url: "http://127.0.0.1:1",
      buildId: "b",
      resolveModule: () => ({}),
      routeTree: createRootRoute(),
      instance: "Not A Key",
    }),
  ).toThrow();
});

const mdreader = resolve("examples/mdreader");
const files = resolve("examples/files");
const actionsOf = (events: ApplicationEvent[]) =>
  events.flatMap((e) => (e.type === "request" && e.kind === "action" ? [e.target] : []));
function record(app: Application) {
  const events: ApplicationEvent[] = [];
  app.onEvent((e) => events.push(e));
  return events;
}
async function panes(ui: TestUI, texts: string[]) {
  await act(async () => {
    await until(() => {
      void ui.renderOnce();
      const frame = ui.captureCharFrame();
      return texts.every((t) => frame.includes(t));
    }, 15_000);
  });
}

test("two panes of one build, two Servers: own modules, own Server Functions", async () => {
  await build(mdreader);
  const { buildId } = await readManifest(mdreader);
  const left = await mkdtemp(join(tmpdir(), "airtty-pane-a-"));
  const right = await mkdtemp(join(tmpdir(), "airtty-pane-b-"));
  await Bun.write(join(left, "README.md"), "# Left\n\nServed to pane a.\n");
  await Bun.write(join(right, "README.md"), "# Right\n\nServed to pane b.\n");
  const server = join(mdreader, ".airtty/server/index.js");
  const a = await launch(server, { MD_PATH: left });
  const b = await launch(server, { MD_PATH: right });
  let ui: TestUI | undefined;
  try {
    // One bundle evaluation per pane, as a host of several panes loads them.
    const paneA = await importClient(mdreader, "instance-a");
    const paneB = await importClient(mdreader, "instance-b");
    const appA = paneA.createApp({ url: a.url, instance: "a" });
    const appB = paneB.createApp({ url: b.url, instance: "b" });
    const eventsA = record(appA);
    const eventsB = record(appB);
    ui = await testRender(
      <box flexDirection="row" flexGrow={1}>
        <box flexGrow={1} flexBasis={0}>
          <paneA.Shell app={appA} />
        </box>
        <box flexGrow={1} flexBasis={0}>
          <paneB.Shell app={appB} />
        </box>
      </box>,
      { width: 160, height: 24 },
    );
    await panes(ui, ["Served to pane a.", "Served to pane b."]);
    // Each pane's references resolve with its own evaluation's modules.
    const reader = `${buildId}/components/Reader.tsx`;
    const ownA = globalThis.__webpack_require__(`a@${reader}`);
    expect(ownA).toBe(appA.options.resolveModule(reader));
    expect(ownA).not.toBe(appB.options.resolveModule(reader));
    expect(globalThis.__webpack_require__(`b@${reader}`)).toBe(appB.options.resolveModule(reader));
    // `useLive(watchLibrary)` is imported by a Client Component: each pane's call leaves
    // through its own Application, to its own Server.
    await act(async () => {
      await until(() => actionsOf(eventsA).length > 0 && actionsOf(eventsB).length > 0);
    });
    expect(actionsOf(eventsA).every((t) => t.startsWith(`${buildId}/actions/`))).toBe(true);
  } finally {
    await destroy(ui);
    await a.stop();
    await b.stop();
    await rm(left, { recursive: true, force: true });
    await rm(right, { recursive: true, force: true });
  }
}, 60_000);

/** The keymap a host's Shell provides, which <Embed> filters for its pane. */
function HostKeymap({ children }: { children: ReactNode }) {
  const renderer = useRenderer();
  const [keymap] = useState(() => createDefaultOpenTuiKeymap(renderer));
  return <KeymapProvider keymap={keymap}>{children}</KeymapProvider>;
}

test("two panes of one build on one shared runtime: bundles evaluated per pane", async () => {
  await build(mdreader);
  const { buildId } = await readManifest(mdreader);
  const left = await mkdtemp(join(tmpdir(), "airtty-shared-a-"));
  const right = await mkdtemp(join(tmpdir(), "airtty-shared-b-"));
  await Bun.write(join(left, "README.md"), "# Left\n\nShared runtime, pane a.\n");
  await Bun.write(join(right, "README.md"), "# Right\n\nShared runtime, pane b.\n");
  const server = join(mdreader, ".airtty/server/index.js");
  const a = await launch(server, { MD_PATH: left });
  const b = await launch(server, { MD_PATH: right });
  let ui: TestUI | undefined;
  const bundle = join(mdreader, ".airtty/app");
  const appA = await openApplication({ bundle, url: a.url, instance: "sa" });
  const appB = await openApplication({ bundle, url: b.url, instance: "sb" });
  try {
    const eventsA = record(appA);
    const eventsB = record(appB);
    ui = await testRender(
      <HostKeymap>
        <box flexDirection="row" flexGrow={1}>
          <Embed app={appA} name="a" active flexGrow={1} />
          <Embed app={appB} name="b" active={false} flexGrow={1} />
        </box>
      </HostKeymap>,
      { width: 160, height: 24 },
    );
    await panes(ui, ["Shared runtime, pane a.", "Shared runtime, pane b."]);
    const reader = `${buildId}/components/Reader.tsx`;
    // Same runtime, separate module instances: each pane its own.
    expect(globalThis.__webpack_require__(`sa@${reader}`)).not.toBe(
      globalThis.__webpack_require__(`sb@${reader}`),
    );
    // mdreader's imported watchLibrary() leaves through each pane's own Application.
    await act(async () => {
      await until(() => actionsOf(eventsA).length > 0 && actionsOf(eventsB).length > 0);
    });
  } finally {
    await destroy(ui);
    appA.dispose();
    appB.dispose();
    await a.stop();
    await b.stop();
    await rm(left, { recursive: true, force: true });
    await rm(right, { recursive: true, force: true });
  }
}, 60_000);

test("two builds in one process, each pane with its key", async () => {
  await build(mdreader);
  await build(files);
  const docs = await mkdtemp(join(tmpdir(), "airtty-two-builds-"));
  await Bun.write(join(docs, "README.md"), "# Docs\n\nRendered next to files.\n");
  await Bun.write(join(docs, "second-build-marker.txt"), "x\n");
  const md = await launch(join(mdreader, ".airtty/server/index.js"), { MD_PATH: docs });
  const fx = await launch(join(files, ".airtty/server/index.js"), { FILES_ROOT: docs });
  let ui: TestUI | undefined;
  try {
    const mdClient = await importClient(mdreader, "two-builds-md");
    const fxClient = await importClient(files, "two-builds-files");
    const mdApp = mdClient.createApp({ url: md.url, instance: "md" });
    const fxApp = fxClient.createApp({ url: fx.url, instance: "fx" });
    ui = await testRender(
      <box flexDirection="row" flexGrow={1}>
        <box flexGrow={1} flexBasis={0}>
          <mdClient.Shell app={mdApp} />
        </box>
        <box flexGrow={1} flexBasis={0}>
          <fxClient.Shell app={fxApp} />
        </box>
      </box>,
      { width: 180, height: 24 },
    );
    await panes(ui, ["Rendered next to files.", "second-build-marker.txt"]);
  } finally {
    await destroy(ui);
    await md.stop();
    await fx.stop();
    await rm(docs, { recursive: true, force: true });
  }
}, 60_000);

test("the Server refuses a malformed instance key and prefixes a valid one", async () => {
  await build(mdreader);
  const { buildId } = await readManifest(mdreader);
  const docs = await mkdtemp(join(tmpdir(), "airtty-instance-server-"));
  await Bun.write(join(docs, "README.md"), "# Home\n");
  const server = await launch(join(mdreader, ".airtty/server/index.js"), { MD_PATH: docs });
  try {
    const render = (instance?: string) =>
      fetch(`${server.url}/render?route=/`, {
        headers: {
          "x-airtty-build": server.buildId,
          ...(instance === undefined ? {} : { "x-airtty-instance": instance }),
        },
      });
    expect((await render("Not A Key")).status).toBe(400);
    const plain = await (await render()).text();
    const keyed = await (await render("p7")).text();
    // The page travels in a nested Flight stream: its references carry the key too.
    expect(plain).toContain(`"${buildId}/components/`);
    expect(plain).not.toContain(`p7@`);
    expect(keyed).toContain(`"p7@${buildId}/components/`);
  } finally {
    await server.stop();
    await rm(docs, { recursive: true, force: true });
  }
}, 60_000);
