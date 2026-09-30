/**
 * The Seatbelt (SBPL) profile of one sandboxed child, generated from the capabilities
 * the user granted its origin (docs/EMBEDDING.md, section 5). Deny by default; the base
 * rules are the minimum Bun and OpenTUI need to start, measured by bisection in
 * probes/sandbox on macOS 26.6 / Bun 1.4.2: removing one makes the child abort, or
 * silently change behavior (the time zone). Sub-processes inherit the profile.
 *
 * Every capability the profile opens has a line in `enforcement` (src/sandbox/grants.ts)
 * naming who applies it: the profile is the "OS" of those lines.
 */
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { Capabilities } from "../capabilities";

/** What the child runs: Bun, its libraries, the luciole runtime and its packages. */
export type SandboxRuntime = {
  /** The real path of the `bun` executable (Seatbelt sees real paths). */
  bun: string;
  /** Directories of the non-system dylibs `bun` links (a Nix or Homebrew ICU). */
  libraries: readonly string[];
  /** Read-only code: luciole's sources, the node_modules it resolves, their manifests. */
  code: readonly string[];
};
/** How the child reaches its application's Server, which is always allowed. */
export type ServerRoute =
  /** A confined Server (src/sandbox/server.ts) dials no Server. */
  | { kind: "none" }
  | { kind: "loopback"; port: number }
  | { kind: "socket"; path: string }
  | { kind: "proxy" };
export type ChildPlan = {
  runtime: SandboxRuntime;
  /** What the user granted the origin; `pty` never reaches here on macOS. */
  capabilities: Capabilities;
  /** The child's private scratch directory (its TMPDIR and HOME), read-write. */
  tmp: string;
  /** The application: its manifest and the cached bundle it links to. */
  readable: readonly string[];
  /** The origin's sessions directory. */
  writable: readonly string[];
  /** The PTY slave the host allocated for this child, by its exact path. */
  tty?: string;
  server: ServerRoute;
  /** The loopback port a confined Server listens on, and no other. */
  listen?: number;
  /** Loopback port of the host's egress proxy, when `net` lists hosts or the Server is remote. */
  proxyPort?: number;
};

// SBPL strings are Scheme strings: only the backslash and the quote need escaping.
const str = (s: string) => `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
// Seatbelt matches the vnode's real path: /tmp is /private/tmp, /var is /private/var.
// A path that does not exist yet (a file to create) keeps its resolved parent.
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : `${real(parent)}/${basename(path)}`;
  }
}
/** Those of `paths` that are symbolic links, by their own path (parent resolved). */
function linked(paths: readonly string[]) {
  return paths.flatMap((p) => {
    try {
      return lstatSync(p).isSymbolicLink() ? [`${real(dirname(p))}/${basename(p)}`] : [];
    } catch {
      return [];
    }
  });
}
const subpaths = (paths: readonly string[]) =>
  paths.map((p) => `(subpath ${str(real(p))})`).join(" ");
// Module resolution stats every ancestor (package.json, tsconfig.json lookups): the
// metadata of those directories only, not their listing or their other files.
function ancestors(paths: readonly string[]) {
  const out = new Set<string>();
  for (const p of paths) {
    let directory = dirname(real(p));
    while (directory !== "/" && !out.has(directory)) {
      out.add(directory);
      directory = dirname(directory);
    }
  }
  return [...out].map((d) => `(literal ${str(d)})`).join(" ");
}
const allow = (operations: string, filters: string) =>
  filters ? [`(allow ${operations} ${filters})`] : [];

export function seatbeltProfile(plan: ChildPlan): string {
  const { runtime, capabilities: caps } = plan;
  const readable = [...runtime.code, ...plan.readable, ...caps.fs.read];
  const writable = [plan.tmp, ...plan.writable, ...caps.fs.write];
  const rules = [
    "(version 1)",
    "(deny default)",
    // Only the runtime itself; `exec` below widens it.
    `(allow process-exec (literal ${str(runtime.bun)}))`,
    // Without sysctl reads Bun's allocator cannot size itself and aborts. Read-only kernel
    // facts (CPU count, page size).
    "(allow sysctl-read)",
    // dyld stats "/" and maps the shared cache; system libraries are in /usr/lib.
    `(allow file-read* (literal "/") (subpath "/usr/lib") (subpath "/private/var/db/dyld"))`,
    `(allow file-read* (literal ${str(runtime.bun)}) ${subpaths(runtime.libraries)})`,
    `(allow file-read* (literal "/dev/urandom") (literal "/dev/random") (literal "/dev/null"))`,
    `(allow file-write-data (literal "/dev/null"))`,
    // Without the /etc and /var links themselves, Bun silently falls back to UTC.
    `(allow file-read* (literal "/etc") (literal "/var") (literal "/private/etc/localtime") (subpath "/private/var/db/timezone") (subpath "/usr/share/zoneinfo"))`,
    // Its own terminal, by exact path: raw mode and the window size are ioctls on the
    // slave it inherited. Never /dev/ttys*, which would reach the user's other terminals.
    ...(plan.tty ? [`(allow file-ioctl (literal ${str(real(plan.tty))}))`] : []),
    ...allow("file-read-metadata", ancestors([...readable, ...writable])),
    // Bun's resolver lists the directory holding `node_modules`; without it Bun aborts
    // with a misleading "bun is unable to write files: EPERM". Its listing only.
    ...runtime.code
      .filter((p) => basename(p) === "node_modules")
      .map((p) => `(allow file-read-data (literal ${str(dirname(real(p)))}))`),
    // A readable path that is a link (a project's node_modules pointing at the framework's
    // packages): the link itself, its ancestors' metadata, and the listing of the
    // directory holding a node_modules link, for the resolver to follow it. What it points
    // to is covered by its real path.
    ...linked(readable).flatMap((link) => [
      `(allow file-read* (literal ${str(link)}))`,
      `(allow file-read-metadata (literal ${str(dirname(link))}))`,
      ...allow("file-read-metadata", ancestors([dirname(link)])),
      ...(basename(link) === "node_modules"
        ? [`(allow file-read-data (literal ${str(dirname(link))}))`]
        : []),
    ]),
    ...allow("file-read*", subpaths(readable)),
    ...allow("file-read* file-write*", subpaths(writable)),
  ];
  if (caps.exec === true) rules.push("(allow process-exec process-fork)");
  else if (caps.exec !== false && caps.exec.length)
    rules.push(
      "(allow process-fork)",
      `(allow process-exec file-read* ${caps.exec.map((p) => `(literal ${str(real(p))})`).join(" ")})`,
    );
  // A Server: its own port, bound and accepting, nothing else inbound (probes/studio-server-sandbox).
  if (plan.listen !== undefined)
    rules.push(
      `(allow network-bind (local ip ${str(`localhost:${plan.listen}`)}))`,
      `(allow network-inbound (local ip ${str(`localhost:${plan.listen}`)}))`,
    );
  // The Server of the application, whatever else is granted.
  if (plan.server.kind === "loopback")
    rules.push(`(allow network-outbound (remote ip ${str(`localhost:${plan.server.port}`)}))`);
  else if (plan.server.kind === "socket")
    rules.push(`(allow network-outbound (literal ${str(real(plan.server.path))}))`);
  if (caps.net.includes("*"))
    // Any host: nothing to filter by name, so the OS lets traffic and DNS through.
    rules.push(
      "(allow network-outbound)",
      `(allow mach-lookup (global-name "com.apple.dnssd.service") (global-name "com.apple.mDNSResponder"))`,
      `(allow file-read* (literal "/private/etc/hosts") (literal "/private/etc/resolv.conf"))`,
    );
  else if (plan.proxyPort !== undefined)
    // Seatbelt only accepts `*` or `localhost` as a remote host (a name or an IP is a
    // profile error): the OS confines traffic to the host's proxy, which applies the host
    // list. No DNS for the child: the proxy resolves names after checking them.
    rules.push(`(allow network-outbound (remote ip ${str(`localhost:${plan.proxyPort}`)}))`);
  else if (caps.net.length) throw new Error("net lists hosts: the proxy must be started first");
  // No rule for the mediated capabilities: their mach services (pasteboard, usernoted,
  // launchservicesd, securityd) stay denied, the child asks the host over IPC.
  return rules.join("\n");
}

/** argv running `argv` under `profile`: sandbox-exec, a fresh process, nothing inherited. */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
export const sandboxed = (profile: string, argv: readonly string[]) => [
  SANDBOX_EXEC,
  "-p",
  profile,
  ...argv,
];
