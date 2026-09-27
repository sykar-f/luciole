/** @jsxImportSource @opentui/react */
/**
 * studio's check of a generated app after each harness turn, stage by stage, each
 * returning diagnostics a harness can act on (file, line, message): the guard, the
 * build, the type check, then a headless render of the first page against its real
 * Server. The first stage that fails stops the rest: its diagnostics go back to the
 * harness as the next prompt.
 */
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { act, Component, type ReactNode } from "react";
import { testRender } from "@opentui/react/test-utils";
import { build } from "../../packages/airtty/src/build";
import { messageOf } from "../../packages/airtty/src/guards";
import { destroy, importClient, launch, until } from "../../tests/helpers";
import { guard } from "./guard";

const TSC = resolve(import.meta.dir, "../../node_modules/.bin/tsc");
const WIDTH = 100;
const HEIGHT = 30;
const RENDER_TIMEOUT_MS = 8000;
// The first frame is not the page: it must hold still this long to count as rendered.
const SETTLE_MS = 400;
const POLL_MS = 20;
const DECIMALS = 10;
const MAX_DIAGNOSTICS = 5;

export const STAGES = ["guard", "build", "types", "render"] as const;
export type Stage = (typeof STAGES)[number];
export type Diagnostic = { file?: string; line?: number; message: string };
export type Outcome = {
  /** The first stage that failed, or `ok`. */
  result: Stage | "ok";
  diagnostics: Diagnostic[];
  /** Time per stage that ran, in ms. */
  timings: Partial<Record<Stage, number>>;
  /** The page as rendered, when the render stage ran. */
  frame?: string;
};

const ms = (start: number) => Math.round((performance.now() - start) * DECIMALS) / DECIMALS;
/** `path:line:column: message`, as Bun and tsc print them. */
const POSITION =
  /^(?:.*?\/)?((?:app|components|server|actions)\/[^:(]+)[:(](\d+)[:,](\d+)\)?:?\s*(.*)$/;
function diagnosticsOf(text: string): Diagnostic[] {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const found: Diagnostic[] = [];
  for (const line of lines) {
    const match = POSITION.exec(line);
    if (match) found.push({ file: match[1], line: Number(match[2]), message: match[4] ?? line });
  }
  return (found.length ? found : lines.map((message) => ({ message }))).slice(0, MAX_DIAGNOSTICS);
}

/** Records a render error React would otherwise only log. */
class Catch extends Component<
  { onError: (error: unknown) => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

async function render(directory: string): Promise<{ diagnostics: Diagnostic[]; frame: string }> {
  let server: Awaited<ReturnType<typeof launch>>;
  try {
    server = await launch(join(directory, ".airtty/server/index.js"));
  } catch (error: unknown) {
    // A Server that does not start: its stderr says why (first lines only).
    return { diagnostics: diagnosticsOf(`server start: ${messageOf(error)}`), frame: "" };
  }
  let serverErrors = "";
  server.child.stderr?.on("data", (chunk: Buffer) => (serverErrors += chunk.toString()));
  const logged: string[] = [];
  const original = console.error;
  // React reports errors a route boundary caught through console.error.
  console.error = (...args: unknown[]) => logged.push(args.map((a) => messageOf(a)).join(" "));
  const caught: unknown[] = [];
  const failedLoads: string[] = [];
  const { createApp, Shell } = await importClient(directory, crypto.randomUUID());
  const app = createApp({ url: server.url });
  app.onEvent((event) => {
    if (event.type === "loader" && event.phase === "end" && event.result === "error")
      failedLoads.push(event.href);
  });
  const ui = await testRender(
    <Catch onError={(error) => caught.push(error)}>
      <Shell app={app} />
    </Catch>,
    { width: WIDTH, height: HEIGHT },
  );
  let frame = "";
  try {
    const read = () => {
      void ui.renderOnce();
      return ui.captureCharFrame();
    };
    // Settled: the same frame for SETTLE_MS, after the first route resolved or failed.
    let last = "";
    let since = performance.now();
    await act(async () => {
      await until(() => {
        const now = read();
        if (now !== last) {
          last = now;
          since = performance.now();
        }
        const loaded =
          app.status === "Connected" ||
          app.error !== "" ||
          caught.length > 0 ||
          failedLoads.length > 0;
        return loaded && now.trim() !== "" && performance.now() - since > SETTLE_MS;
      }, RENDER_TIMEOUT_MS);
    });
    await Bun.sleep(POLL_MS);
    frame = read();
  } catch (error: unknown) {
    logged.push(`render did not settle: ${messageOf(error)}`);
  } finally {
    console.error = original;
    app.dispose();
    await destroy(ui);
    await server.stop();
  }
  const diagnostics: Diagnostic[] = [
    ...caught.map((error) => ({ message: `client render: ${messageOf(error)}` })),
    ...(app.error ? [{ message: `server: ${app.error}` }] : []),
    ...failedLoads.map((path) => ({ message: `route ${path} failed to load` })),
    ...logged.map((message) => ({ message: `logged: ${message.split("\n")[0] ?? ""}` })),
    ...diagnosticsOf(serverErrors).map((d) => ({ ...d, message: `server log: ${d.message}` })),
  ];
  return { diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS), frame };
}

/** Applies nothing: `directory` already holds the change set, `changes` is what was written. */
export async function validate(
  directory: string,
  changes: ReadonlyMap<string, string>,
): Promise<Outcome> {
  const timings: Partial<Record<Stage, number>> = {};
  let start = performance.now();
  const refused = guard(changes);
  timings.guard = ms(start);
  if (refused.length)
    return {
      result: "guard",
      diagnostics: refused.map(({ file, reason }) => ({ file, message: reason })),
      timings,
    };

  start = performance.now();
  try {
    await build(directory);
  } catch (error: unknown) {
    timings.build = ms(start);
    // Paths relative to the workspace: what the harness knows the files by.
    const message = messageOf(error).replaceAll(`${directory}/`, "");
    return { result: "build", diagnostics: diagnosticsOf(message), timings };
  }
  timings.build = ms(start);

  start = performance.now();
  const tsc = spawnSync(TSC, ["--noEmit", "-p", directory], { encoding: "utf8" });
  timings.types = ms(start);
  if (tsc.status !== 0)
    return { result: "types", diagnostics: diagnosticsOf(`${tsc.stdout}${tsc.stderr}`), timings };

  start = performance.now();
  const rendered = await render(directory);
  timings.render = ms(start);
  if (rendered.diagnostics.length)
    return { result: "render", diagnostics: rendered.diagnostics, timings, frame: rendered.frame };
  return { result: "ok", diagnostics: [], timings, frame: rendered.frame };
}
