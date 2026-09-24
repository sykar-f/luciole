/**
 * Capabilities → Seatbelt (SBPL) profile for macOS. Deny by default; the base rules are
 * the minimum `bun` needed to start, found by bisection on macOS 26.6 / Bun 1.4.2 (see
 * README): removing any of them makes `bun -e 0` abort.
 */
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { granted, type Capabilities, type EnforcementReport } from "./capabilities";

export type Runtime = {
  /** The real path of the `bun` executable (symlinks resolved: Seatbelt sees real paths). */
  bun: string;
  /** Directories of the non-system dylibs `bun` links (a Nix or Homebrew ICU). */
  libraries: readonly string[];
  /** Read-only code: the application bundle and its node_modules. */
  code: readonly string[];
  /** A private scratch directory, the child's TMPDIR, read-write. */
  tmp: string;
  /** Loopback port of the host's egress proxy, when `net` lists hosts. */
  proxyPort?: number;
};

// SBPL strings are Scheme strings: only the backslash and the quote need escaping.
const str = (s: string) => `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
// Seatbelt matches the vnode's real path: /tmp is /private/tmp, /var is /private/var.
// A path that does not exist yet (a file to create) keeps its resolved parent.
function real(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return `${realpathSync(dirname(path))}/${path.slice(dirname(path).length + 1)}`;
  }
}
const subpaths = (paths: readonly string[]) =>
  paths.map((p) => `(subpath ${str(real(p))})`).join(" ");
// Module resolution stats every ancestor (package.json, tsconfig.json lookups): allow the
// metadata of those directories only, not their listing or their other files.
function ancestors(paths: readonly string[]) {
  const out = new Set<string>();
  for (const p of paths) {
    let dir = dirname(real(p));
    while (dir !== "/" && !out.has(dir)) {
      out.add(dir);
      dir = dirname(dir);
    }
  }
  return [...out].map((d) => `(literal ${str(d)})`).join(" ");
}

export function profileFor(caps: Capabilities, runtime: Runtime) {
  const readable = [...runtime.code, ...caps.fs.read];
  const writable = [runtime.tmp, ...caps.fs.write];
  const rules = [
    "(version 1)",
    "(deny default)",
    // Only the runtime itself; `exec` below widens it.
    `(allow process-exec (literal ${str(runtime.bun)}))`,
    // Measured: without sysctl reads Bun's allocator cannot size itself and aborts
    // ("memory allocation of 48 bytes failed"). Read-only kernel facts (CPU count, page size).
    "(allow sysctl-read)",
    // Measured: dyld stats "/" and maps the shared cache; the system libraries live in
    // /usr/lib and the cache under /private/var/db/dyld. Nothing of /System was needed.
    `(allow file-read* (literal "/") (subpath "/usr/lib") (subpath "/private/var/db/dyld"))`,
    `(allow file-read* (literal ${str(runtime.bun)}) ${subpaths(runtime.libraries)})`,
    // Randomness for crypto.getRandomValues; /dev/null for discarded stdio.
    `(allow file-read* (literal "/dev/urandom") (literal "/dev/random") (literal "/dev/null"))`,
    `(allow file-write-data (literal "/dev/null"))`,
    // Timezone data: Date formats local time from /etc/localtime → /var/db/timezone.
    // Measured: the /etc and /var symlinks must be readable too, or Bun silently uses UTC.
    `(allow file-read* (literal "/etc") (literal "/var") (literal "/private/etc/localtime") (subpath "/private/var/db/timezone") (subpath "/usr/share/zoneinfo"))`,
    `(allow file-read-metadata ${ancestors([...readable, ...writable])})`,
    // Measured: Bun's resolver lists the directory holding `node_modules` (and aborts with
    // "bun is unable to write files: EPERM" otherwise). Its listing only, not its files.
    ...runtime.code
      .filter((p) => p.endsWith("/node_modules"))
      .map((p) => `(allow file-read-data (literal ${str(dirname(real(p)))}))`),
    `(allow file-read* ${subpaths(readable)})`,
    `(allow file-read* file-write* ${subpaths(writable)})`,
  ];
  const report: EnforcementReport = [];
  const names = granted(caps);
  if (names.includes("fs.read"))
    report.push({ capability: "fs.read", by: "os", note: "file-read* per subpath" });
  if (names.includes("fs.write"))
    report.push({ capability: "fs.write", by: "os", note: "file-write* per subpath" });
  if (caps.exec === true) {
    rules.push("(allow process-exec process-fork)");
    report.push({ capability: "exec", by: "os", note: "any binary; children inherit the sandbox" });
  } else if (Array.isArray(caps.exec) && caps.exec.length) {
    rules.push(
      `(allow process-fork)`,
      `(allow process-exec file-read* ${caps.exec.map((p) => `(literal ${str(real(p))})`).join(" ")})`,
    );
    report.push({
      capability: "exec",
      by: "os",
      note: "listed binaries; children inherit the sandbox",
    });
  }
  if (caps.pty) {
    // posix_openpt opens /dev/ptmx; grantpt/unlockpt and the slave use /dev/ttysNNN.
    rules.push(
      `(allow file-read* file-write* file-ioctl (literal "/dev/ptmx") (regex #"^/dev/ttys[0-9]+$"))`,
    );
    report.push({ capability: "pty", by: "os", note: "/dev/ptmx and /dev/ttys*" });
  }
  if (caps.net.length) {
    if (caps.net.includes("*")) {
      // Any host: nothing to filter by name, so the OS lets traffic and DNS through.
      rules.push(
        "(allow network-outbound)",
        `(allow mach-lookup (global-name "com.apple.dnssd.service") (global-name "com.apple.mDNSResponder"))`,
        `(allow file-read* (literal "/private/etc/hosts") (literal "/private/etc/resolv.conf"))`,
      );
      report.push({ capability: "net", by: "os", note: "any host" });
    } else {
      if (runtime.proxyPort === undefined)
        throw new Error("net lists hosts: a proxy port is required");
      // Seatbelt only accepts `*` or `localhost` as a remote host (measured: an IP or a
      // name is a profile error). So the OS confines traffic to the host's proxy, and the
      // proxy applies the host list. No DNS for the child: the proxy resolves names.
      rules.push(`(allow network-outbound (remote ip ${str(`localhost:${runtime.proxyPort}`)}))`);
      report.push({ capability: "net", by: "proxy", note: `only localhost:${runtime.proxyPort}` });
    }
  }
  // No OS rule for these: their mach services (pasteboard, usernoted, launchservicesd,
  // securityd, HID/window server) stay denied by default; the host mediates the grant.
  const mediated = [
    ["clipboard.read", "OSC 52 query, answered by the host"],
    ["clipboard.write", "OSC 52 set, applied by the host"],
    ["notify", "OSC 9/777, shown by the host"],
    ["open-url", "host IPC request (or an OSC 8 link the user activates)"],
    ["secrets", "host IPC, keychain entries partitioned by origin"],
    ["input.global", "host forwards keys outside the embed's focus"],
    ["tabs.message", "host IPC between tabs"],
  ] as const;
  for (const [capability, note] of mediated)
    if (names.includes(capability)) report.push({ capability, by: "host", note });
  return { profile: rules.join("\n"), report };
}

/** argv running `argv` under `profile`: sandbox-exec is deprecated but ships with macOS 26. */
export const sandboxed = (profile: string, argv: readonly string[]) => [
  "/usr/bin/sandbox-exec",
  "-p",
  profile,
  ...argv,
];
