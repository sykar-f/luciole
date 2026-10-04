/** @jsxImportSource @opentui/react */
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "../packages/core/src/client";
import type { NetworkConditions } from "../packages/core/src/transport";
import { launch, importClient, type PrivateBuild } from "./helpers";

// Key names as bindings write them, to the mock terminal's codes.
const KEYS: Record<string, string> = {
  return: "RETURN",
  escape: "ESCAPE",
  tab: "TAB",
  up: "ARROW_UP",
  down: "ARROW_DOWN",
  end: "END",
};

type ClientOptions = {
  network?: NetworkConditions;
  /** What a crashed Client left: its route and named fields. */
  session?: Session;
  width?: number;
  height?: number;
};
type Options = ClientOptions & {
  /** coder's command line (app/args.ts); the scripted harness by default. */
  argv?: readonly string[];
  env?: Record<string, string>;
};

/** A generated Client of `url` in OpenTUI's test renderer, with its own runtime. */
async function openClient(built: PrivateBuild, url: string, options: ClientOptions) {
  const { createApp, Shell } = await importClient(built.directory, crypto.randomUUID());
  const app = createApp({
    url,
    latencyMs: 0,
    network: options.network,
    session: options.session,
  });
  await app.router.load();
  const ui = await testRender(<Shell app={app} />, {
    width: options.width ?? 120,
    height: options.height ?? 36,
  });
  const frame = async () => {
    await ui.renderOnce();
    return ui.captureCharFrame();
  };
  /** One React batch per call: a real terminal delivers separate reads. */
  const step = (work: () => unknown) =>
    act(async () => {
      await work();
    });
  const settle = (ms = 30) => step(() => Bun.sleep(ms));
  const waitFor = async (check: string | RegExp | ((frame: string) => boolean), timeout = 8000) => {
    const start = performance.now();
    const matches = (shown: string) =>
      typeof check === "string"
        ? shown.includes(check)
        : check instanceof RegExp
          ? check.test(shown)
          : check(shown);
    for (;;) {
      await settle(20);
      const shown = await frame();
      if (matches(shown)) return shown;
      if (performance.now() - start > timeout)
        throw new Error(`Frame never showed ${String(check)}:\n${shown}`);
    }
  };
  const type = (text: string) => step(() => ui.mockInput.typeText(text));
  const press = (key: string, modifiers?: { ctrl?: boolean; shift?: boolean; meta?: boolean }) =>
    step(() => ui.mockInput.pressKey(KEYS[key] ?? key, modifiers));
  /** Types a prompt and sends it with Enter. */
  const prompt = async (text: string) => {
    await type(text);
    await settle();
    await press("return");
  };
  const close = () => act(async () => ui.renderer.destroy());
  return { app, ui, frame, step, settle, waitFor, type, press, prompt, close };
}

/**
 * A real coder Server on the scripted harness (fast: 1 ms between chunks) and a real
 * generated Client rendered in OpenTUI's test renderer; `client()` opens another one.
 */
export async function startCoder(built: PrivateBuild, options: Options = {}) {
  const temp = await mkdtemp(join(tmpdir(), "coder-"));
  const server = await launch(join(built.output, "server/index.js"), {
    LUCIOLE_ARGS: JSON.stringify({ v: 1, argv: options.argv ?? ["--harness", "fake"], cwd: temp }),
    XDG_STATE_HOME: join(temp, "state"),
    CODER_FAKE_DELAY_MS: "1",
    ...options.env,
  });
  const first = await openClient(built, server.url, options);
  let closed = false;
  async function stop() {
    if (!closed) await first.close();
    closed = true;
    await server.stop();
    await rm(temp, { recursive: true, force: true });
  }
  return {
    ...first,
    server,
    temp,
    client: (more: ClientOptions = {}) => openClient(built, server.url, more),
    /** Destroys the first Client, as a crash would (its session stays with the test). */
    crash: async () => {
      closed = true;
      await first.close();
    },
    stop,
  };
}
export type Coder = Awaited<ReturnType<typeof startCoder>>;
