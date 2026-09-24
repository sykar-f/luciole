/**
 * What the user grants an origin opened in the `sandbox` mode, and who enforces each
 * grant (docs/EMBEDDING.md, section 1). The application declares capabilities in its
 * signed manifest; the user accepts them once per origin, and adds more with Deno-like
 * flags (`--allow-read=/data`, `--allow-net=api.example.com`…), remembered in the
 * origin's `origin.json`.
 *
 * Absolute rule: a capability is shown as granted only if the OS, the proxy or the host
 * really applies it. What cannot be applied here is refused before anything runs.
 */
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { Capabilities } from "../capabilities";

/** Who applies a grant: the kernel sandbox, the host's egress proxy, the host over IPC. */
export type Enforcer = "os" | "proxy" | "host";
export type Enforced = { capability: string; by: Enforcer; how: string };

const NONE = Capabilities.parse({});
const LIST_FLAGS = {
  "--allow-read": "read",
  "--allow-write": "write",
  "--allow-net": "net",
  "--allow-exec": "exec",
  "--allow-secrets": "secrets",
} as const;
const BOOLEAN_FLAGS = {
  "--allow-clipboard-read": (c: Capabilities) => void (c.clipboard.read = true),
  "--allow-clipboard-write": (c: Capabilities) => void (c.clipboard.write = true),
  "--allow-notify": (c: Capabilities) => void (c.notify = true),
  "--allow-open-url": (c: Capabilities) => void (c.openUrl = true),
  "--allow-input-global": (c: Capabilities) => void (c.inputGlobal = true),
  "--allow-tabs-message": (c: Capabilities) => void (c.tabsMessage = true),
  "--allow-pty": (c: Capabilities) => void (c.pty = true),
} as const;
const isKey = <T extends Record<string, unknown>>(
  table: T,
  key: string,
): key is Extract<keyof T, string> => Object.hasOwn(table, key);

/** `~/x`, `./x` → absolute: the profile matches real, absolute paths. */
function absolutePath(path: string, cwd: string) {
  const expanded =
    path === "~" ? homedir() : path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/** Whether `arg` is one of the `--allow-*` flags. */
export const isAllowFlag = (arg: string) => /^--allow-[a-z-]+(=|$)/.test(arg);

/** The capabilities `--allow-*` flags grant; an unknown flag or a missing value throws. */
export function parseAllowFlags(args: readonly string[], cwd = process.cwd()): Capabilities {
  // Fresh arrays: a schema's defaults are shared by every parse and must stay empty.
  const caps: Capabilities = {
    fs: { read: [], write: [] },
    net: [],
    exec: false,
    pty: false,
    clipboard: { read: false, write: false },
    notify: false,
    openUrl: false,
    secrets: [],
    inputGlobal: false,
    tabsMessage: false,
  };
  for (const arg of args) {
    const at = arg.indexOf("=");
    const flag = at < 0 ? arg : arg.slice(0, at);
    const values =
      at < 0
        ? []
        : arg
            .slice(at + 1)
            .split(",")
            .filter(Boolean);
    if (isKey(BOOLEAN_FLAGS, flag) && at < 0) BOOLEAN_FLAGS[flag](caps);
    else if (flag === "--allow-exec" && at < 0) caps.exec = true;
    else if (isKey(LIST_FLAGS, flag) && values.length) {
      const kind = LIST_FLAGS[flag];
      if (kind === "read") caps.fs.read.push(...values.map((p) => absolutePath(p, cwd)));
      else if (kind === "write") caps.fs.write.push(...values.map((p) => absolutePath(p, cwd)));
      else if (kind === "net") caps.net.push(...values);
      else if (kind === "secrets") caps.secrets.push(...values);
      else if (caps.exec !== true)
        caps.exec = [...(caps.exec || []), ...values.map((p) => absolutePath(p, cwd))];
    } else
      throw new Error(
        `${arg}: expected --allow-read=<paths>, --allow-write=<paths>, --allow-net=<hosts>, ` +
          "--allow-exec[=<binaries>], --allow-secrets=<names> or one of " +
          Object.keys(BOOLEAN_FLAGS).join(", "),
      );
  }
  // Validated as the manifest's own field: absolute paths, host patterns.
  return Capabilities.parse(caps);
}

const union = <T>(a: readonly T[], b: readonly T[]) => [...new Set([...a, ...b])];
const binaries = (c: Capabilities) => (c.exec === true || c.exec === false ? [] : c.exec);
const execOf = (list: string[]): Capabilities["exec"] => (list.length ? list : false);
/** Everything either grants. */
export function mergeCapabilities(a: Capabilities, b: Capabilities): Capabilities {
  return {
    fs: { read: union(a.fs.read, b.fs.read), write: union(a.fs.write, b.fs.write) },
    net: union(a.net, b.net),
    exec: a.exec === true || b.exec === true ? true : execOf(union(binaries(a), binaries(b))),
    pty: a.pty || b.pty,
    clipboard: {
      read: a.clipboard.read || b.clipboard.read,
      write: a.clipboard.write || b.clipboard.write,
    },
    notify: a.notify || b.notify,
    openUrl: a.openUrl || b.openUrl,
    secrets: union(a.secrets, b.secrets),
    inputGlobal: a.inputGlobal || b.inputGlobal,
    tabsMessage: a.tabsMessage || b.tabsMessage,
  };
}
/** What `wanted` asks beyond `granted`, or `undefined` when nothing. */
export function beyond(wanted: Capabilities, granted: Capabilities): Capabilities | undefined {
  const extra = (a: readonly string[], b: readonly string[]) => a.filter((x) => !b.includes(x));
  // Any binary is beyond a list; a list is beyond nothing once any binary is granted.
  const exec =
    granted.exec === true || wanted.exec === false
      ? false
      : wanted.exec === true || execOf(extra(wanted.exec, binaries(granted)));
  const more: Capabilities = {
    fs: {
      read: extra(wanted.fs.read, granted.fs.read),
      write: extra(wanted.fs.write, granted.fs.write),
    },
    net: extra(wanted.net, granted.net),
    exec,
    pty: wanted.pty && !granted.pty,
    clipboard: {
      read: wanted.clipboard.read && !granted.clipboard.read,
      write: wanted.clipboard.write && !granted.clipboard.write,
    },
    notify: wanted.notify && !granted.notify,
    openUrl: wanted.openUrl && !granted.openUrl,
    secrets: extra(wanted.secrets, granted.secrets),
    inputGlobal: wanted.inputGlobal && !granted.inputGlobal,
    tabsMessage: wanted.tabsMessage && !granted.tabsMessage,
  };
  return JSON.stringify(more) === JSON.stringify(NONE) ? undefined : more;
}

/**
 * Why these grants cannot be enforced by a macOS sandbox, or `undefined`. `pty`: Seatbelt
 * only matches the slave's path, and the child's own PTYs get paths nobody knows in
 * advance; the only rule that lets it use them (/dev/ttys*) also opens every terminal of
 * the user (measured), where it could read what is typed. Everything at once: the
 * sandbox would enforce nothing, so it is not pretended.
 */
export function unenforceable(caps: Capabilities): string | undefined {
  if (caps.pty)
    return (
      "pty cannot be confined on macOS: Seatbelt would have to open every terminal of " +
      "yours (/dev/ttys*), where the application could read what you type in them"
    );
  const everywhere = (paths: readonly string[]) => paths.includes("/");
  if (
    everywhere(caps.fs.read) &&
    everywhere(caps.fs.write) &&
    caps.net.includes("*") &&
    caps.exec === true
  )
    return "everything is granted: the sandbox would enforce nothing";
  return undefined;
}

const MEDIATED = "l'OS bloque la voie directe, l'hôte vérifie chaque demande (IPC)";
/** One line per granted capability: who applies it and how (macOS). */
export function enforcement(caps: Capabilities): Enforced[] {
  const lines: Enforced[] = [];
  if (caps.fs.read.length)
    lines.push({
      capability: `fs.read ${caps.fs.read.join(" ")}`,
      by: "os",
      how: "Seatbelt, lecture par chemin",
    });
  if (caps.fs.write.length)
    lines.push({
      capability: `fs.write ${caps.fs.write.join(" ")}`,
      by: "os",
      how: "Seatbelt, écriture par chemin",
    });
  if (caps.net.includes("*"))
    lines.push({ capability: "net *", by: "os", how: "Seatbelt, tout le réseau" });
  else if (caps.net.length)
    lines.push({
      capability: `net ${caps.net.join(" ")}`,
      by: "proxy",
      how: "liste d'hôtes au proxy ; Seatbelt limite l'app au port du proxy",
    });
  if (caps.exec === true)
    lines.push({ capability: "exec", by: "os", how: "Seatbelt, tout binaire, sandbox héritée" });
  else if (caps.exec !== false && caps.exec.length)
    lines.push({
      capability: `exec ${caps.exec.join(" ")}`,
      by: "os",
      how: "Seatbelt, ces binaires, sandbox héritée",
    });
  const host = (on: boolean, capability: string) => {
    if (on) lines.push({ capability, by: "host", how: MEDIATED });
  };
  host(caps.clipboard.read, "clipboard.read");
  host(caps.clipboard.write, "clipboard.write");
  host(caps.notify, "notify");
  host(caps.openUrl, "open-url");
  host(caps.secrets.length > 0, `secrets ${caps.secrets.join(" ")}`);
  host(caps.inputGlobal, "input.global");
  host(caps.tabsMessage, "tabs.message");
  return lines;
}
export const ENFORCERS: Record<Enforcer, string> = { os: "OS", proxy: "proxy", host: "hôte" };
