/**
 * One sandboxed origin (docs/EMBEDDING.md, section 5), from the host's side: the route to
 * its Server, the egress proxy, a private scratch directory (src/sandbox/confine.ts), then
 * its Client started confined (Seatbelt, or luciole-sandbox on Linux) on a PTY the VT
 * widget shows, with an IPC channel for the capabilities
 * the host mediates. Everything is set up before the child starts (the proxy listens,
 * its port is held) and torn down after it ends.
 */
import { mkdirSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Capabilities } from "../capabilities";
import { ClientFailure } from "../dev/supervisor";
import { connect } from "../connect";
import type { CapabilityState, HostEvent, HostRequest, MediatedCapability } from "../host";
import { sessionDirectory } from "../session";
import { spawnPty, type Pty } from "../vt/pty";
import type { TerminalIo } from "../vt/terminal";
import { answer } from "./ipc";
import { createPermissions, type Permissions, type Question } from "./permissions";
import { confine, scratch, type Confinement } from "./confine";
import type { Mechanism } from "./mechanism";
import type { SandboxRuntime } from "./profile";
import type { EgressProxy } from "./proxy";

// Passed through: how the user reads text and time, and whether a desktop window hosts
// the Client (Ctrl+C then quits nothing); nothing that names a secret or a path.
const PASSED = ["LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TZ", "LUCIOLE_DESKTOP"];

export type SandboxOrigin = {
  origin: string;
  /** The Server's URL, as the user gave it. */
  url: string;
  /** `<origin>/app`: the manifest as received and a link to the cached bundle. */
  app: string;
  /** The publisher key pinned for the origin: the child refuses any other. */
  fingerprint: string;
  /** `openSession` name of the origin's sessions. */
  sessions: string;
  granted: Capabilities;
  /** What the user refused: capability names, `secrets:<name>` (origin.json). */
  denied?: readonly string[];
  /**
   * Bun, luciole and the built child (src/sandbox/runtime.ts), found by the launcher, which
   * runs from luciole's sources: this module also runs inside the bundled generic Client.
   */
  runtime: SandboxRuntime;
  child: string;
  /** What confines it on this system (src/sandbox/mechanism.ts), found by the launcher. */
  mechanism: Mechanism;
};
export type SandboxOptions = {
  /** Performs a granted request (src/host.ts, `performDirectly` or the host's tabs). */
  perform: (request: HostRequest) => Promise<unknown>;
  /** `XDG_STATE_HOME` whose `luciole/<sessions>/sessions` the child writes. */
  env?: NodeJS.ProcessEnv;
  /** Asks the user about a capability the origin has not been granted nor refused. */
  ask?: (question: Question) => Promise<boolean>;
  /** A decision the user made (to remember); the child is told already. */
  onChange?: (change: { capability: MediatedCapability; state: CapabilityState }) => void;
  /** Tests: maps a proxied name to the address actually dialled. */
  resolve?: (host: string) => string;
  /** Tests: sees the profile generated for the child. */
  onProfile?: (profile: string) => void;
  /** A page of the child failed (src/run.tsx): studio reads it to correct the app. */
  onFailure?: (failure: ClientFailure) => void;
};
export type Sandbox = {
  /** Starts the child; the VT widget calls it once it knows its size. */
  spawn(io: TerminalIo): Pty;
  /** An event for the child, sent only when its grants let it hear it. */
  deliver(event: HostEvent): void;
  /** Where its mediated capabilities stand, as the user decides. */
  readonly permissions: Permissions;
  readonly proxy: EgressProxy | undefined;
  close(): Promise<void>;
};

export async function openSandbox(
  origin: SandboxOrigin,
  options: SandboxOptions,
): Promise<Sandbox> {
  const env = options.env ?? process.env;
  const { granted, runtime } = origin;
  const connection = await connect(origin.url, undefined, env);
  const tmp = scratch();
  let confinement: Confinement | undefined;
  try {
    const sessions = sessionDirectory(origin.sessions, env);
    mkdirSync(sessions, { recursive: true, mode: 0o700 });
    // The manifest, and the cached bundle its link points to.
    const readable = [
      origin.app,
      ...readdirSync(origin.app).map((f) => realpathSync(join(origin.app, f))),
    ];
    confinement = await confine({
      mechanism: origin.mechanism,
      runtime,
      granted,
      tmp: tmp.path,
      readable,
      writable: [sessions],
      server: { url: origin.url, connection },
      resolve: options.resolve,
      onProfile: options.onProfile,
    });
    const confined = confinement;
    const childEnv: Record<string, string> = {
      PATH: "/usr/bin:/bin",
      HOME: tmp.path,
      TMPDIR: tmp.path,
      // Where sessionDirectory() put the origin's sessions, which the profile opens.
      XDG_STATE_HOME: env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
      // Nothing to cache: the child could not write it anyway.
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      ...Object.fromEntries(PASSED.flatMap((name) => (env[name] ? [[name, env[name]]] : []))),
      ...confined.env,
    };
    const permissions = createPermissions({
      granted,
      denied: origin.denied,
      ask: options.ask,
      onChange: (change) => {
        child?.send({ kind: "event", event: { type: "capability", ...change } });
        options.onChange?.(change);
      },
    });
    const argv = [
      origin.child,
      "--url",
      confined.serverUrl,
      "--bundle",
      origin.app,
      "--origin",
      origin.origin,
      "--sessions",
      origin.sessions,
      "--publisher",
      origin.fingerprint,
    ];
    let child: Pty | undefined;
    // A host that quits through process.exit unmounts nothing: the child, which has its
    // own session, must not outlive it, nor its scratch directory.
    const exit = () => {
      child?.kill();
      tmp.remove();
    };
    process.on("exit", exit);
    return {
      proxy: confined.proxy,
      permissions,
      spawn: (io) => {
        child = spawnPty({
          ...io,
          cwd: tmp.path,
          env: childEnv,
          environment: "replace",
          command: (tty) =>
            confined.command(tty, [
              runtime.bun,
              // Never fetch a package: what it lacks is an error, not a download.
              "--no-install",
              ...argv,
              "--capabilities",
              JSON.stringify(permissions.states()),
            ]),
          ipc: (message) => {
            const failure = ClientFailure.safeParse(message);
            if (failure.success) return options.onFailure?.(failure.data);
            void answer(message, (request) => permissions.allow(request), options.perform).then(
              (reply) => {
                if (reply) child?.send(reply);
              },
            );
          },
        });
        return child;
      },
      deliver: (event) => {
        if (permissions.hears(event)) child?.send({ kind: "event", event });
      },
      close: async () => {
        process.off("exit", exit);
        exit();
        connection.close();
        await confined.close();
      },
    };
  } catch (error: unknown) {
    connection.close();
    await confinement?.close();
    tmp.remove();
    throw error;
  }
}
