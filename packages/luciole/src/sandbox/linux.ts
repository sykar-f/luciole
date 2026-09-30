/**
 * The Linux confinement of one sandboxed child (docs/EMBEDDING.md, decision 6): the
 * policy luciole-sandbox applies (native/luciole-sandbox/src/policy.rs, the same shape,
 * validated there again), and for the `bwrap` mechanism the bubblewrap arguments around
 * it. Everything is argv: no shell ever sees a path.
 */
import { lstatSync, readlinkSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { Capabilities } from "../capabilities";
import type { LinuxMechanism } from "./mechanism";
import type { SandboxRuntime } from "./profile";

/** What the child may connect to (src/sandbox/confine.ts decides). */
export type LinuxNetwork =
  | { mode: "open" }
  | { mode: "ports"; tcp: number[] }
  | { mode: "isolated"; relays: { port: number; socket: string }[] };
export type LinuxPlan = {
  mechanism: LinuxMechanism;
  runtime: SandboxRuntime;
  capabilities: Capabilities;
  /** The child's private scratch directory, read-write. */
  tmp: string;
  readable: readonly string[];
  writable: readonly string[];
  network: LinuxNetwork;
};

/** The minimum a dynamically linked Bun reads to start (measured in a container). */
const SYSTEM_READ = [
  "/usr",
  "/lib",
  "/lib64",
  "/etc/ld.so.cache",
  "/etc/ld.so.conf",
  "/etc/ld.so.conf.d",
  "/etc/localtime",
  "/etc/timezone",
  "/etc/passwd",
  "/etc/group",
  "/etc/nsswitch.conf",
  "/etc/os-release",
  // Certificates: the child speaks TLS itself through the proxy's CONNECT tunnels.
  "/etc/ssl",
  "/etc/ca-certificates",
  "/etc/pki",
  "/dev/urandom",
  "/dev/random",
  // CPU and memory facts; its own /proc/<pid> comes from `procSelf`.
  "/proc/stat",
  "/proc/meminfo",
  "/proc/cpuinfo",
  "/sys/devices/system/cpu",
  "/sys/fs/cgroup",
];
/** Only with `net: *`: name resolution. */
const RESOLVER_READ = ["/etc/resolv.conf", "/etc/hosts", "/etc/gai.conf"];
/** The kernel opens the ELF interpreter to exec a dynamic binary: it needs EXECUTE too. */
const LOADERS = [
  "/lib64/ld-linux-x86-64.so.2",
  "/lib/ld-linux-aarch64.so.1",
  "/lib/ld-musl-x86_64.so.1",
  "/lib/ld-musl-aarch64.so.1",
];
/** Landlock ABI the `landlock` mechanism needs (signal and abstract socket scoping). */
const ABI_SCOPE = 6;

export function launcherPolicy(plan: LinuxPlan) {
  const { mechanism, runtime, capabilities: caps } = plan;
  const execute = caps.exec === true ? ["/"] : caps.exec === false ? [] : [...caps.exec];
  const read = [
    ...SYSTEM_READ,
    ...(plan.network.mode === "open" ? RESOLVER_READ : []),
    ...runtime.libraries,
    ...runtime.code,
    ...plan.readable,
    ...caps.fs.read,
  ];
  // The child's own pseudo-terminals, in its private devpts (never offered otherwise).
  const devices = caps.pty ? ["/dev/ptmx", "/dev/pts"] : [];
  return {
    version: 1,
    namespaces: mechanism.kind === "userns",
    network: plan.network,
    devpts: mechanism.kind === "userns" && caps.pty,
    landlock:
      mechanism.landlockAbi > 0
        ? {
            minAbi: mechanism.kind === "landlock" ? ABI_SCOPE : 1,
            read,
            // Bun's resolver lists the directory holding node_modules (its files stay closed).
            list: runtime.code.filter((p) => basename(p) === "node_modules").map((p) => dirname(p)),
            readWrite: [plan.tmp, ...plan.writable, ...caps.fs.write, "/dev/null"],
            execute: [runtime.bun, ...LOADERS, ...execute],
            devices,
            procSelf: true,
          }
        : null,
    // Without a network namespace, Landlock filters TCP only.
    seccomp: { denyUdp: plan.network.mode === "ports" },
  };
}
export type LauncherPolicy = ReturnType<typeof launcherPolicy>;

const each = (flag: string, paths: readonly string[]) => paths.flatMap((p) => [flag, p, p]);
/** Top-level directories a merged-/usr system replaces with links into /usr. */
const TOP_LEVEL = ["/bin", "/sbin", "/lib", "/lib64", "/lib32"];
function linkTarget(path: string) {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined;
  } catch {
    return undefined;
  }
}
/** `paths` without those under another of them, nor under a top-level link into /usr. */
function uncovered(paths: readonly string[]) {
  const unique = [...new Set(paths)];
  const under = (path: string, parent: string) => path !== parent && path.startsWith(`${parent}/`);
  return unique.filter(
    (path) =>
      !unique.some((other) => under(path, other)) &&
      !TOP_LEVEL.some((top) => under(path, top) && linkTarget(top) !== undefined),
  );
}
/**
 * bubblewrap around the launcher: namespaces, and a root where only what the child needs
 * is mounted (what confines files when the kernel has no Landlock). `--dev` brings a
 * private devpts, so the user's terminals are not in it.
 */
function bwrapArgs(plan: LinuxPlan, policy: LauncherPolicy) {
  const { mechanism, capabilities: caps } = plan;
  const landlock = policy.landlock;
  const read = landlock?.read ?? [
    ...SYSTEM_READ,
    ...plan.runtime.libraries,
    ...plan.runtime.code,
    ...plan.readable,
    ...caps.fs.read,
  ];
  const writable = landlock?.readWrite.filter((p) => p !== "/dev/null") ?? [
    plan.tmp,
    ...plan.writable,
    ...caps.fs.write,
  ];
  const sockets = plan.network.mode === "isolated" ? plan.network.relays.map((r) => r.socket) : [];
  // Read-only: what is not under a directory mounted already (a nested mount of the same
  // file fails on a symlinked parent, /lib on a merged-/usr system).
  const readOnly = uncovered([
    ...read.filter((p) => !p.startsWith("/proc") && !p.startsWith("/dev")),
    plan.runtime.bun,
    mechanism.launcher,
    ...(caps.exec === true || caps.exec === false ? [] : caps.exec),
  ]);
  return [
    mechanism.bwrap ?? "bwrap",
    "--die-with-parent",
    "--unshare-user",
    "--unshare-ipc",
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-cgroup-try",
    ...(plan.network.mode === "open" ? [] : ["--unshare-net"]),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    // /bin, /lib… as the system has them: directories, or links into /usr.
    ...TOP_LEVEL.flatMap((path) => {
      const target = linkTarget(path);
      return target === undefined ? ["--ro-bind-try", path, path] : ["--symlink", target, path];
    }),
    ...readOnly.flatMap((p) => (TOP_LEVEL.includes(p) ? [] : ["--ro-bind-try", p, p])),
    ...each("--bind", writable),
    ...each("--bind", sockets),
    "--chdir",
    plan.tmp,
  ];
}

/** argv running `argv` confined by `plan`. */
export function linuxCommand(plan: LinuxPlan, argv: readonly string[]) {
  const policy = launcherPolicy(plan);
  const launcher = [plan.mechanism.launcher, "--policy", JSON.stringify(policy), "--", ...argv];
  return plan.mechanism.kind === "bwrap"
    ? [...bwrapArgs(plan, policy), "--", ...launcher]
    : launcher;
}
