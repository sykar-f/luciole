/**
 * The preview's Server side (docs/studio/SPEC.md, 3.3): each attempt is built apart
 * (`.airtty-studio/builds/<id>`, signed with the project's own publisher key), its Server
 * started confined, and only then does the preview switch to it; the previous Server
 * stops once the switch is done. The Client of the preview runs in studio's Client
 * process (components/Preview.tsx), where its terminal is drawn.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  build,
  fingerprintOf,
  generatePublisherKey,
  readPublisherKey,
  type PublisherKey,
} from "airtty/build";
import { startAppServer, type AppServer } from "airtty/dev";
import {
  Capabilities,
  confineServer,
  sandboxAvailability,
  sandboxRuntime,
  type ServerSandbox,
} from "airtty/sandbox";
import type { Project } from "./project";

export type PreviewMode = "sandbox" | "process";
/** What the Client needs to show a revision (components/Preview.tsx). */
export type PreviewTarget = {
  revision: number;
  url: string;
  /** The build: `app/` (signed bundle) and `client/index.js`. */
  output: string;
  fingerprint: string;
  mode: PreviewMode;
  granted: Capabilities;
  /** Where the preview's sessions (route, named fields) are kept, by name. */
  sessions: string;
};
export type Diagnostic = { file?: string; line?: number; message: string };

// Builds kept besides the one shown: a quick restore does not rebuild.
const BUILDS_KEPT = 3;
// The previous Server outlives the switch this long, for the new Client to take over.
const RETIRE_MS = 5000;
const TYPES_TIMEOUT_MS = 60_000;
const MS_PER_SECOND = 1000;
const MAX_DIAGNOSTICS = 5;
/** `path:line:column: message` (the build) or `path(line,column): error …` (tsc). */
const POSITION =
  /^(?:.*?\/)?((?:app|components|server|actions)\/[^:(\s]+)[:(](\d+)[:,](\d+)\)?:?\s*(.*)$/;

/** Diagnostics a harness can act on: file and line when the text has them, 5 at most. */
export function diagnosticsOf(text: string, project?: string): Diagnostic[] {
  const lines = text
    .replaceAll(project ? `${project}/` : "\0", "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const found = lines.flatMap((line) => {
    const match = POSITION.exec(line);
    return match ? [{ file: match[1], line: Number(match[2]), message: match[4] || line }] : [];
  });
  return (found.length ? found : lines.map((message) => ({ message }))).slice(0, MAX_DIAGNOSTICS);
}

/** Why the preview cannot be isolated here, or nothing when it can. */
export function isolationProblem(mode: PreviewMode): string | undefined {
  if (mode === "process") return undefined;
  const availability = sandboxAvailability();
  if (!availability.mechanism) return availability.reason;
  // The confined Server listens only under Seatbelt for now (airtty/sandbox).
  if (availability.mechanism.kind !== "seatbelt")
    return "the generated app's Server can be confined on macOS only for now";
  return undefined;
}

type Running = { target: PreviewTarget; server: AppServer; box?: ServerSandbox };

export class PreviewServers {
  private current: Running | undefined;
  /** Every Server started and not yet stopped: the current one and those retiring. */
  private readonly alive = new Set<Running>();
  private key: PublisherKey | undefined;
  private readonly project: Project;
  private readonly mode: PreviewMode;
  granted: Capabilities = Capabilities.parse({});
  constructor(project: Project, mode: PreviewMode) {
    this.project = project;
    this.mode = mode;
  }

  /** The project's publisher key: made on first use, never the user's own. */
  private publisher() {
    if (this.key) return this.key;
    const env = {
      AIRTTY_PUBLISHER_KEY: join(this.project.privateDirectory("key"), "publisher.pem"),
    };
    if (!existsSync(env.AIRTTY_PUBLISHER_KEY)) generatePublisherKey(env);
    this.key = readPublisherKey(env);
    return this.key;
  }

  /** Builds the working tree into a directory of its own. */
  async build(id: string): Promise<{ output: string } | { diagnostics: Diagnostic[] }> {
    const output = join(this.project.privateDirectory("builds"), id);
    try {
      await build(this.project.directory, output, { signBundle: this.publisher() });
      return { output };
    } catch (error: unknown) {
      rmSync(output, { recursive: true, force: true });
      const message = error instanceof Error ? error.message : String(error);
      return { diagnostics: diagnosticsOf(message, this.project.directory) };
    }
  }

  /** `tsc --noEmit` on the project: diagnostics, none when the types hold. */
  types(): Promise<Diagnostic[]> {
    const tsc = join(this.project.directory, "node_modules/.bin/tsc");
    return new Promise((done) => {
      // From the project: tsc names files relative to where it runs.
      const child = spawn(tsc, ["--noEmit", "-p", "."], {
        cwd: this.project.directory,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
      const timer = setTimeout(() => {
        child.kill();
        done([
          {
            message: `tsc took more than ${TYPES_TIMEOUT_MS / MS_PER_SECOND} s: types not checked`,
          },
        ]);
      }, TYPES_TIMEOUT_MS);
      child.on("exit", (code) => {
        clearTimeout(timer);
        done(code === 0 ? [] : diagnosticsOf(output, this.project.directory));
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        done([{ message: `tsc did not run: ${error.message}` }]);
      });
    });
  }

  /**
   * Starts the Server of `output` for `revision`, confined unless the preview runs in
   * `process` mode. Rejects with what the Server said when it does not start.
   */
  async start(revision: number, output: string): Promise<PreviewTarget> {
    const data = this.project.data();
    const box =
      this.mode === "sandbox"
        ? await confineServer({
            mechanism: { kind: "seatbelt" },
            runtime: sandboxRuntime(),
            granted: this.granted,
            // Its build and the project's manifest; the node_modules link to the
            // framework's packages resolves into the runtime's code, readable already.
            readable: [
              output,
              join(this.project.directory, "package.json"),
              join(this.project.directory, "node_modules"),
            ],
            writable: [data],
          })
        : undefined;
    let errors = "";
    try {
      const server = await startAppServer({
        directory: this.project.directory,
        output,
        env: box
          ? { ...box.env, STUDIO_DATA: data }
          : { ...process.env, PORT: "0", STUDIO_DATA: data },
        ...(box ? { command: box.command } : {}),
        stderr: (text) => (errors += text),
      });
      const target: PreviewTarget = {
        revision,
        url: `http://127.0.0.1:${server.port}`,
        output,
        fingerprint: fingerprintOf(this.publisher().publicKey),
        mode: this.mode,
        granted: this.granted,
        sessions: `studio-${this.project.name}`,
      };
      const previous = this.current;
      this.current = { target, server, box };
      this.alive.add(this.current);
      if (previous) setTimeout(() => void this.retire(previous), RETIRE_MS);
      this.prune();
      return target;
    } catch (error: unknown) {
      await box?.close();
      throw error;
    }
  }

  private async retire(running: Running) {
    await running.server.stop();
    await running.box?.close();
    this.alive.delete(running);
  }

  /**
   * Ends every preview Server at once, synchronously: for `process.on("exit")`, when the
   * studio's own Server stops (SIGTERM, a rebuild) and may not wait.
   */
  killAll() {
    for (const running of this.alive) running.server.child.kill("SIGTERM");
    this.alive.clear();
  }

  /** Removes old builds, never the one shown. */
  private prune() {
    const builds = this.project.privateDirectory("builds");
    const shown = this.current?.target.output;
    const all = readdirSync(builds)
      .map((name) => join(builds, name))
      .filter((path) => path !== shown)
      .sort();
    for (const path of all.slice(0, Math.max(0, all.length - BUILDS_KEPT)))
      rmSync(path, { recursive: true, force: true });
  }

  get target() {
    return this.current?.target;
  }

  async stop() {
    const running = this.current;
    this.current = undefined;
    if (running) await this.retire(running);
  }
}
