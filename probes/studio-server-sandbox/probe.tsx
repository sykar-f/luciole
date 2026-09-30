/** @jsxImportSource @opentui/react */
/**
 * studio runs code a model wrote. The `sandbox` mode of docs/EMBEDDING.md confines a
 * Client; the generated app's Server (its pages, Server Functions, `server/`) would still
 * run with the user's rights. Can that Server run under Seatbelt too, with the profile
 * src/sandbox/profile.ts generates plus the right to listen on one loopback port, and
 * still serve the preview? And what does it lose? macOS only.
 *
 *   bun probes/studio-server-sandbox/probe.tsx      # from the repository root
 */
import { spawn } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { z } from "zod";
import { build } from "../../packages/luciole/src/build";
import { Capabilities } from "../../packages/luciole/src/capabilities";
import { sandboxed, seatbeltProfile } from "../../packages/luciole/src/sandbox/profile";
import { sandboxAvailability, sandboxRuntime } from "../../packages/luciole/src/sandbox/runtime";
import { destroy, importClient, until } from "../../tests/helpers";

const HERE = import.meta.dir;
const TEMPLATE = resolve(HERE, "../studio-preview/template");
const WORK = join(HERE, ".luciole-work");
const STARTUP_TIMEOUT_MS = 15_000;
const RENDER_TIMEOUT_MS = 10_000;
const WIDTH = 100;
const HEIGHT = 30;
const REPEATS = 7;
const DECIMALS = 10;

const results: Record<string, unknown> = {
  date: new Date().toISOString(),
  platform: `${process.platform} ${process.arch}`,
  bun: Bun.version,
};
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results[name] = detail === undefined ? ok : { ok, detail };
  if (!ok) failures.push(name);
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`,
  );
}
const ms = (start: number) => Math.round((performance.now() - start) * DECIMALS) / DECIMALS;
const median = (values: readonly number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN;

if (sandboxAvailability().mechanism?.kind !== "seatbelt") {
  console.log("Seatbelt only: nothing to do on this system");
  process.exit(0);
}

// Outside the workspace: what generated code must not reach.
const outside = realpathSync(mkdtempSync(join(tmpdir(), "studio-outside-")));
const CANARY = join(outside, "canary.txt");
writeFileSync(CANARY, "secret outside the workspace");
// A local service the generated Server must not reach either.
const service = createServer((socket) => socket.end("service reached")).listen(0, "127.0.0.1");
await new Promise((done) => service.once("listening", done));
const serviceAddress = service.address();
const servicePort = typeof serviceAddress === "object" && serviceAddress ? serviceAddress.port : 0;

// The template, plus a page section that tries to leave the workspace and says how it went.
const directory = join(WORK, "app");
rmSync(directory, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
cpSync(TEMPLATE, directory, { recursive: true });
const data = join(directory, "data");
mkdirSync(data, { recursive: true });
writeFileSync(
  join(directory, "server/escape.ts"),
  `import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
const attempt = async (run: () => unknown) => {
  try {
    await run();
    return "allowed";
  } catch (error: unknown) {
    return error instanceof Error && "code" in error ? String(error.code) : String(error);
  }
};
const dial = (port: number) =>
  new Promise<void>((done, fail) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.end();
      done();
    });
    socket.on("error", fail);
  });
export async function escape() {
  return {
    readOutside: await attempt(() => readFileSync(${JSON.stringify(CANARY)}, "utf8")),
    writeOutside: await attempt(() => writeFileSync(${JSON.stringify(join(outside, "written.txt"))}, "x")),
    writeData: await attempt(() => writeFileSync(${JSON.stringify(join(data, "db.txt"))}, "x")),
    readHome: await attempt(() => readFileSync(${JSON.stringify(join(process.env.HOME ?? "/", ".zshrc"))}, "utf8")),
    localService: await attempt(() => dial(${servicePort})),
    internet: await attempt(() => fetch("https://example.com", { signal: AbortSignal.timeout(3000) })),
    spawn: await attempt(() => Bun.spawnSync(["/bin/echo", "spawned"]).stdout.toString()),
  };
}
`,
);
writeFileSync(
  join(directory, "app/page.tsx"),
  readFileSync(join(directory, "app/page.tsx"), "utf8")
    .replace(
      'import { count } from "../server/store";',
      'import { count } from "../server/store";\nimport { escape } from "../server/escape";',
    )
    .replace(
      "export default function Page() {",
      "export default async function Page() {\n  const attempts = await escape();",
    )
    .replace(
      '<text id="studio-greeting">{greeting}</text>',
      '<text id="studio-greeting">{greeting}</text>\n      <text id="studio-escape">{`ESCAPE ${JSON.stringify(attempts)}`}</text>',
    ),
);
const built = await build(directory);

async function freePort() {
  const probe = createServer().listen(0, "127.0.0.1");
  await new Promise((done) => probe.once("listening", done));
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((done) => probe.close(done));
  return port;
}

const Ready = z.object({ ready: z.literal(true), port: z.number().int() });
/** The generated Server, confined or not; resolves once it listens. */
async function startServer(confined: boolean) {
  const port = await freePort();
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "studio-server-")));
  const entry = [
    process.execPath,
    "--conditions=react-server",
    join(directory, ".luciole/server/index.js"),
  ];
  let profile = "";
  if (confined) {
    const runtime = sandboxRuntime();
    profile = [
      seatbeltProfile({
        runtime: { ...runtime, bun: realpathSync(process.execPath) },
        capabilities: Capabilities.parse({}),
        tmp: scratch,
        // The built app only: its sources stay unreadable, and so does everything else.
        readable: [join(directory, ".luciole"), join(directory, "package.json")],
        writable: [data],
        // No terminal: the Server's stdio are pipes.
        tty: "/dev/null",
        // Unused: a Server dials no Server. Port 9 (discard) is closed.
        server: { kind: "loopback", port: 9 },
      }),
      // What a Server needs beyond a Client's profile: to listen, on its one port.
      `(allow network-bind (local ip "localhost:${port}"))`,
      `(allow network-inbound (local ip "localhost:${port}"))`,
    ].join("\n");
  }
  const argv = confined ? sandboxed(profile, entry) : entry;
  const started = performance.now();
  const [command, ...rest] = argv;
  if (!command) throw new Error("empty command");
  const child = spawn(command, rest, {
    env: {
      PATH: "/usr/bin:/bin",
      HOME: scratch,
      TMPDIR: scratch,
      PORT: String(port),
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (chunk: Buffer) => (errors += chunk.toString()));
  const ready = await new Promise<z.infer<typeof Ready>>((done, fail) => {
    const timer = setTimeout(
      () => fail(new Error(`startup timeout: ${errors}`)),
      STARTUP_TIMEOUT_MS,
    );
    child.once("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`exited ${code}: ${errors}`));
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return;
      }
      const parsed = Ready.safeParse(value);
      if (parsed.success) {
        clearTimeout(timer);
        done(parsed.data);
      }
    });
  });
  return {
    url: `http://127.0.0.1:${ready.port}`,
    startMs: ms(started),
    errors: () => errors,
    stop: () =>
      new Promise<void>((done) => {
        if (child.exitCode !== null || child.signalCode !== null) return done();
        child.once("exit", () => done());
        child.kill("SIGTERM");
      }),
  };
}

const EscapeLine = z.object({
  readOutside: z.string(),
  writeOutside: z.string(),
  writeData: z.string(),
  readHome: z.string(),
  localService: z.string(),
  internet: z.string(),
  spawn: z.string(),
});
/** Renders the preview's first page against `url` (the host's Client, unconfined here). */
async function render(url: string) {
  const { createApp, Shell } = await importClient(directory, crypto.randomUUID());
  const app = createApp({ url });
  const ui = await testRender(<Shell app={app} />, { width: WIDTH, height: HEIGHT });
  const frame = () => {
    void ui.renderOnce();
    return ui.captureCharFrame();
  };
  try {
    await act(async () => {
      await until(() => frame().includes("ESCAPE {"), RENDER_TIMEOUT_MS);
    });
    // The line may wrap: join the frame's lines before reading the JSON.
    const text = frame()
      .split("\n")
      .map((line) => line.trim())
      .join("");
    const json = text.slice(text.indexOf("ESCAPE ") + "ESCAPE ".length, text.indexOf("}") + 1);
    return EscapeLine.parse(JSON.parse(json));
  } finally {
    app.dispose();
    await destroy(ui);
  }
}

try {
  const open = await startServer(false);
  const reference = await render(open.url);
  await open.stop();
  check(
    "unconfined: generated Server code has the user's rights",
    reference.readOutside === "allowed" && reference.spawn === "allowed",
    reference,
  );

  const confined = await startServer(true);
  try {
    const attempts = await render(confined.url);
    check("confined Server starts and serves the preview", true, {
      startMs: confined.startMs,
      buildId: built.buildId,
    });
    check(
      "reads outside the workspace refused",
      attempts.readOutside !== "allowed" && attempts.readHome !== "allowed",
      attempts,
    );
    check("writes outside the data directory refused", attempts.writeOutside !== "allowed");
    check("writes inside the data directory allowed", attempts.writeData === "allowed");
    check(
      "local services and the internet unreachable",
      attempts.localService !== "allowed" && attempts.internet !== "allowed",
    );
    check("spawning a program refused", attempts.spawn !== "allowed");
  } finally {
    await confined.stop();
  }

  // What confinement costs a reload: the Server restarts after every rebuild.
  const bare: number[] = [];
  const boxed: number[] = [];
  for (let i = 0; i < REPEATS; i++) {
    for (const [confine, samples] of [
      [false, bare],
      [true, boxed],
    ] as const) {
      const server = await startServer(confine);
      samples.push(server.startMs);
      await server.stop();
    }
  }
  check("Server start, median of 7 (ms)", true, {
    bare: median(bare),
    confined: median(boxed),
    bareSamples: bare,
    confinedSamples: boxed,
  });
} catch (error: unknown) {
  check("probe completed", false, String(error));
} finally {
  service.close();
}

writeFileSync(join(HERE, "results.json"), JSON.stringify(results, null, 2) + "\n");
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
