/**
 * What an application may do, declared statically in `luciole.capabilities` of its
 * package.json (docs/EMBEDDING.md, decision 3), copied by the build into its bundle's
 * manifest. Deno-like: every field defaults to nothing. Declaring is not enforcing: only
 * the `sandbox` mode applies them (steps 7 and 8); `inline` and `process` apply none,
 * and a host says so. Shape measured on the sandbox modes:
 *
 * - `exec` is `false`, `true` or absolute binaries: Seatbelt and Landlock match
 *   executables by path, and a sandboxed exec inherits the sandbox;
 * - `clipboard` keeps read and write apart although the OS cannot: the host mediates
 *   both, and that is what the user is asked.
 *
 * zod/mini: the Client reads it from bundle manifests.
 */
import { isAbsolute } from "node:path";
import * as z from "zod/mini";

const AbsolutePath = z.string().check(z.refine(isAbsolute, "must be an absolute path"));
// `host`, `*.host`, `host:port` or `*` (any host).
const HostPattern = z
  .string()
  .check(z.regex(/^(\*|(\*\.)?[a-z0-9.-]+)(:\d{1,5})?$/i, "must be host, *.host, host:port or *"));
const flag = () => z._default(z.boolean(), false);

export const Capabilities = z.object({
  fs: z._default(
    z.object({
      read: z._default(z.array(AbsolutePath), []),
      write: z._default(z.array(AbsolutePath), []),
    }),
    { read: [], write: [] },
  ),
  net: z._default(z.array(HostPattern), []),
  exec: z._default(z.union([z.boolean(), z.array(AbsolutePath)]), false),
  pty: flag(),
  clipboard: z._default(z.object({ read: flag(), write: flag() }), {
    read: false,
    write: false,
  }),
  notify: flag(),
  openUrl: flag(),
  /** Names of secrets the host hands out, stored per origin. */
  secrets: z._default(z.array(z.string()), []),
  inputGlobal: flag(),
  tabsMessage: flag(),
});
export type Capabilities = z.infer<typeof Capabilities>;

/**
 * The capability each Node built-in a Client bundle requires implies, for the build's
 * comparison with what the application declares. Built-ins absent here (`path`, `url`,
 * `crypto`…) compute without reaching outside the process.
 */
const IMPLIED: Record<string, (caps: Capabilities) => boolean> = {
  fs: (c) => c.fs.read.length > 0 || c.fs.write.length > 0,
  "fs/promises": (c) => c.fs.read.length > 0 || c.fs.write.length > 0,
  child_process: (c) => c.exec !== false,
  net: (c) => c.net.length > 0,
  tls: (c) => c.net.length > 0,
  http: (c) => c.net.length > 0,
  https: (c) => c.net.length > 0,
  http2: (c) => c.net.length > 0,
  dgram: (c) => c.net.length > 0,
  dns: (c) => c.net.length > 0,
};
const CAPABILITY_OF: Record<string, string> = {
  fs: "fs.read/fs.write",
  "fs/promises": "fs.read/fs.write",
  child_process: "exec",
};
/** The built-ins a bundle requires that its declared capabilities do not cover. */
export function undeclaredUses(builtins: readonly string[], caps: Capabilities) {
  return builtins.flatMap((specifier) => {
    const name = specifier.replace(/^node:/, "");
    const covered = IMPLIED[name];
    return covered && !covered(caps)
      ? [{ builtin: specifier, capability: CAPABILITY_OF[name] ?? "net" }]
      : [];
  });
}

/** The capabilities `caps` declares, one name each, for what a host shows the user. */
export function granted(caps: Capabilities): string[] {
  const names: string[] = [];
  if (caps.fs.read.length) names.push(`fs.read ${caps.fs.read.join(" ")}`);
  if (caps.fs.write.length) names.push(`fs.write ${caps.fs.write.join(" ")}`);
  if (caps.net.length) names.push(`net ${caps.net.join(" ")}`);
  if (caps.exec === true) names.push("exec");
  else if (caps.exec !== false && caps.exec.length) names.push(`exec ${caps.exec.join(" ")}`);
  if (caps.pty) names.push("pty");
  if (caps.clipboard.read) names.push("clipboard.read");
  if (caps.clipboard.write) names.push("clipboard.write");
  if (caps.notify) names.push("notify");
  if (caps.openUrl) names.push("open-url");
  if (caps.secrets.length) names.push(`secrets ${caps.secrets.join(" ")}`);
  if (caps.inputGlobal) names.push("input.global");
  if (caps.tabsMessage) names.push("tabs.message");
  return names;
}
