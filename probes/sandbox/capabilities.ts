import { isAbsolute } from "node:path";
import { z } from "zod";

/**
 * What an embedded application may do, as its manifest declares it and the user grants
 * it (per origin). Deno-like: every field defaults to "nothing". The shape follows the
 * validated list (fs.read/fs.write by path, net by host, exec/pty, clipboard.read/write,
 * notify, open-url, secrets, input.global, tabs.message), with two adjustments:
 *
 * - `exec` is `false`, `true` or a list of absolute binaries: Seatbelt and Landlock
 *   match executables by path, and a sandboxed exec inherits the sandbox, so a list is
 *   enforceable and `true` stays meaningful (anything, still confined).
 * - `clipboard` keeps read and write apart although the OS cannot (one pasteboard
 *   service on macOS): the host mediates both, so the split costs nothing and matches
 *   what the user is asked.
 */
const AbsolutePath = z.string().refine(isAbsolute, "must be an absolute path");
// `host`, `host:port` or `*` (any host). Ports default to 80/443 at the proxy.
const HostPattern = z
  .string()
  .regex(/^(\*|(\*\.)?[a-z0-9.-]+)(:\d{1,5})?$/i, "must be host, *.host, host:port or *");

export const Capabilities = z.object({
  fs: z
    .object({
      read: z.array(AbsolutePath).default([]),
      write: z.array(AbsolutePath).default([]),
    })
    .default({ read: [], write: [] }),
  net: z.array(HostPattern).default([]),
  exec: z.union([z.boolean(), z.array(AbsolutePath)]).default(false),
  pty: z.boolean().default(false),
  clipboard: z
    .object({ read: z.boolean().default(false), write: z.boolean().default(false) })
    .default({ read: false, write: false }),
  notify: z.boolean().default(false),
  openUrl: z.boolean().default(false),
  /** Names of secrets the host hands out, stored partitioned by origin. */
  secrets: z.array(z.string()).default([]),
  inputGlobal: z.boolean().default(false),
  tabsMessage: z.boolean().default(false),
});
export type Capabilities = z.infer<typeof Capabilities>;
export type CapabilityName =
  | "fs.read"
  | "fs.write"
  | "net"
  | "exec"
  | "pty"
  | "clipboard.read"
  | "clipboard.write"
  | "notify"
  | "open-url"
  | "secrets"
  | "input.global"
  | "tabs.message";

/**
 * Who enforces a granted capability. `os`: the kernel sandbox denies everything else.
 * `proxy`: the OS confines traffic to a host-run proxy, which applies the host list.
 * `host`: the OS denies the direct route (mach service, device); the child asks the
 * host over IPC (or an escape sequence the VT widget intercepts) and the host decides.
 * `unenforced`: granted but not enforceable on this platform — never shown as granted.
 */
export type Enforcement = "os" | "proxy" | "host" | "unenforced";
export type EnforcementReport = { capability: CapabilityName; by: Enforcement; note: string }[];

/** The capabilities an application asked for and got, one line each, for the prompt. */
export function granted(caps: Capabilities): CapabilityName[] {
  const names: CapabilityName[] = [];
  if (caps.fs.read.length) names.push("fs.read");
  if (caps.fs.write.length) names.push("fs.write");
  if (caps.net.length) names.push("net");
  if (caps.exec !== false && (caps.exec === true || caps.exec.length)) names.push("exec");
  if (caps.pty) names.push("pty");
  if (caps.clipboard.read) names.push("clipboard.read");
  if (caps.clipboard.write) names.push("clipboard.write");
  if (caps.notify) names.push("notify");
  if (caps.openUrl) names.push("open-url");
  if (caps.secrets.length) names.push("secrets");
  if (caps.inputGlobal) names.push("input.global");
  if (caps.tabsMessage) names.push("tabs.message");
  return names;
}

/** `host[:port]` split, the port defaulting to what the proxy would dial. */
export function parseHost(pattern: string, defaultPort: number) {
  const at = pattern.lastIndexOf(":");
  if (at < 0) return { host: pattern.toLowerCase(), port: defaultPort, anyPort: true };
  return {
    host: pattern.slice(0, at).toLowerCase(),
    port: Number(pattern.slice(at + 1)),
    anyPort: false,
  };
}

/** Whether `host:port` matches one of the granted patterns (`*`, `*.suffix`, exact). */
export function hostAllowed(patterns: readonly string[], host: string, port: number) {
  const name = host.toLowerCase();
  return patterns.some((pattern) => {
    const p = parseHost(pattern, port);
    if (!p.anyPort && p.port !== port) return false;
    if (p.host === "*") return true;
    if (p.host.startsWith("*.")) return name.endsWith(p.host.slice(1));
    return name === p.host;
  });
}
