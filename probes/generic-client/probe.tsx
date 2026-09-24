/** @jsxImportSource @opentui/react */
// Generic Client probe: download an application's bundle from its Server, verify it,
// render it. `bun probes/generic-client/probe.tsx` from the repository root; writes
// results.json next to this file.
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "bun";
import { launch, until } from "../../tests/helpers";
import type { ApplicationEvent } from "../../src/client";
import { messageOf } from "../../src/guards";
import { runtimeAbi } from "./abi";
import { bundleApp } from "./bundle";
import { EmbedShell, createPanes } from "./host";
import { evaluateBundle, fetchBundle, TrustError } from "./loader";
import { publisherKeys, serveBundle, signBundle } from "./publish";
import { loadRuntime } from "./runtime";

const WIDTH = 100;
const HEIGHT = 30;
const FRAME_TIMEOUT_MS = 10_000;
const PRECISION = 1000;
const FRAME_LINES = 12;
const round = (ms: number) => Math.round(ms * PRECISION) / PRECISION;
const results: Record<string, unknown> = {};
const assertions: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  assertions.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};
async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
    return "accepted";
  } catch (error: unknown) {
    return error instanceof TrustError ? messageOf(error) : `unexpected: ${messageOf(error)}`;
  }
}

const appDir = resolve("examples/mdreader");
const library = await mkdtemp(join(tmpdir(), "airtty-generic-docs-"));
const store = await mkdtemp(join(tmpdir(), "airtty-generic-store-"));
await Bun.write(join(library, "README.md"), "# Handbook\n\nDownloaded, verified, rendered.\n");
await Bun.write(join(library, "guide.md"), "# Guide\n\nSecond document.\n");

const bundle = await bundleApp(appDir);
const unminified = await bundleApp(appDir, { minify: false });
const abi = await runtimeAbi();
results.bundle = {
  app: "examples/mdreader",
  bytes: Buffer.byteLength(bundle.code),
  gzip: gzipSync(bundle.code).byteLength,
  unminifiedBytes: Buffer.byteLength(unminified.code),
  clientModules: bundle.clientModules,
  sources: bundle.sources,
  builtins: bundle.builtins,
  airttyBuildMs: round(bundle.serverBuildMs),
  bundleMs: round(bundle.bundleMs),
  abi,
};
// The Server with the proposed instance prefix (probes/inline/instance-server.ts).
const server = await launch(join(import.meta.dir, "../inline/instance-server.ts"), {
  SERVER_ENTRY: join(appDir, ".airtty/server/index.js"),
  MD_PATH: library,
});
const keys = publisherKeys();
const signed = signBundle(bundle, keys);
const front = serveBundle({ upstream: server.url, signed, code: bundle.code });
const { runtime, buildMs, bytes } = await loadRuntime();
results.runtime = {
  bytes,
  gzip: gzipSync(await Bun.file(join(import.meta.dir, ".out/runtime.js")).text()).byteLength,
  buildMs: round(buildMs),
};

try {
  // Cold start: nothing pinned, nothing cached.
  const coldStart = performance.now();
  const cold = await fetchBundle(front.url, { store, abiKey: abi.key });
  const evalStart = performance.now();
  const panes = createPanes(runtime, { routeBy: "instance" });
  const pane = panes.open(cold.manifest.buildId);
  const loaded = evaluateBundle(cold.code, {
    filename: `airtty-app:${cold.origin}/${cold.manifest.sha256}.js`,
    abi: panes.abiFor(pane),
    builtins: cold.manifest.builtins,
  });
  const evalMs = performance.now() - evalStart;
  check("bundle binds the signed build ID", loaded.buildId === cold.manifest.buildId);
  const app = panes.mount(pane, loaded, { url: front.url });
  const events: ApplicationEvent[] = [];
  app.onEvent((e) => events.push(e));
  await app.router.load();
  const ui = await testRender(<EmbedShell runtime={runtime} app={app} name="mdreader" active />, {
    width: WIDTH,
    height: HEIGHT,
  });
  let frame = "";
  await act(async () => {
    await until(() => {
      void ui.renderOnce();
      frame = ui.captureCharFrame();
      return frame.includes("Downloaded, verified, rendered.");
    }, FRAME_TIMEOUT_MS);
  });
  const firstFrameMs = performance.now() - coldStart;
  check("downloaded mdreader renders its home document", frame.includes("Handbook"));
  // `watchLibrary` is imported by a Client Component: its stub went through the
  // per-origin `airtty/client` and reached this origin's Server.
  const live = events.find(
    (e) => e.type === "request" && e.kind === "action" && e.cause === "live",
  );
  check("imported Server Function (useLive) reaches its own Server", live !== undefined);
  results.cold = {
    ...cold.timings,
    evalMs: round(evalMs),
    firstFrameMs: round(firstFrameMs),
    cacheHit: cold.cacheHit,
  };
  await act(async () => ui.renderer.destroy());

  // Warm start: same store, the bundle comes from the cache by hash.
  const before = front.hits.bundle;
  const warmStart = performance.now();
  const warm = await fetchBundle(front.url, { store, abiKey: abi.key });
  results.warm = {
    ...warm.timings,
    totalMs: round(performance.now() - warmStart),
    cacheHit: warm.cacheHit,
  };
  check(
    "warm start reads the bundle from the cache",
    warm.cacheHit && front.hits.bundle === before,
  );
  results.frame = frame.split("\n").slice(0, FRAME_LINES).join("\n");

  // Refusals, all before evaluation.
  const fresh = () => mkdtemp(join(tmpdir(), "airtty-generic-store-"));
  front.replace({ code: `${bundle.code}\n;globalThis.pwned=1;` });
  const tampered = await refusal(fetchBundle(front.url, { store: await fresh(), abiKey: abi.key }));
  check("tampered bundle refused", tampered.includes("does not match the signed hash"), tampered);
  front.replace({
    code: bundle.code,
    signed: {
      ...signed,
      manifest: { ...signed.manifest, sha256: "0".repeat(bundle.sha256.length) },
    },
  });
  const forged = await refusal(fetchBundle(front.url, { store: await fresh(), abiKey: abi.key }));
  check(
    "manifest altered after signing refused",
    forged.includes("signature does not verify"),
    forged,
  );
  front.replace({ signed: signBundle(bundle, publisherKeys()) });
  const rotated = await refusal(fetchBundle(front.url, { store, abiKey: abi.key }));
  check(
    "publisher key change refused for a pinned origin",
    rotated.includes("publisher key changed"),
    rotated,
  );
  front.replace({ signed: signBundle(bundle, keys, { abi: "0-0000000000000000" }) });
  const abiRefused = await refusal(fetchBundle(front.url, { store, abiKey: abi.key }));
  check("bundle for another runtime ABI refused", abiRefused.includes("runtime ABI"), abiRefused);
  const outside = await refusal(
    Promise.resolve().then(() =>
      evaluateBundle(`(function(exports, require){require("node:child_process")})`, {
        filename: "probe",
        abi: panes.abiFor(panes.open("probe")),
        builtins: [],
      }),
    ),
  );
  check(
    "require outside the ABI and the declared built-ins refused",
    outside.includes("outside the runtime ABI"),
    outside,
  );
  results.hits = front.hits;
} finally {
  await front.stop();
  await server.stop();
  await rm(library, { recursive: true, force: true });
  await rm(store, { recursive: true, force: true });
}
results.assertions = assertions;
results.ranAt = new Date().toISOString();
results.bun = Bun.version;
await Bun.write(join(import.meta.dir, "results.json"), JSON.stringify(results, null, 2) + "\n");
const failed = assertions.filter((a) => !a.ok);
console.log(failed.length ? `${failed.length} assertion(s) failed` : "all assertions passed");
process.exit(failed.length ? 1 : 0);
