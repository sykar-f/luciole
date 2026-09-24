/**
 * Capabilities → Linux confinement, from the same manifest as the Seatbelt profile.
 * Three layers, each covering what the others cannot:
 *
 * - bubblewrap: namespaces. The child sees only bind-mounted paths, has its own network
 *   namespace (only loopback) and PID namespace, and `--new-session` detaches it from
 *   the host terminal (no TIOCSTI into the host's tty).
 * - Landlock: per-path access rights inside what is mounted (execute only listed
 *   binaries, write only granted trees), TCP connect by port (ABI ≥ 4), abstract unix
 *   sockets and signals scoped to the sandbox (ABI ≥ 6). Unprivileged, stackable.
 * - seccomp: syscalls no embedded app needs (ptrace, keyctl, bpf, mount, TIOCSTI…).
 *
 * The probe runs the bubblewrap layer for real in a container; Landlock and seccomp are
 * produced as data (ruleset, syscall list) and checked for consistency.
 */
import { dirname } from "node:path";
import { granted, parseHost, type Capabilities, type EnforcementReport } from "./capabilities";

export type LinuxRuntime = {
  bun: string;
  code: readonly string[];
  tmp: string;
  /** Host path of the egress proxy's unix socket, bind-mounted when `net` lists hosts. */
  proxySocket?: string;
  /** Landlock ABI of the running kernel (0: unavailable), from landlock_create_ruleset. */
  landlockAbi: number;
};

/** In-sandbox path of the proxy socket; a relay exposes it as 127.0.0.1:PROXY_PORT. */
export const PROXY_SOCKET = "/run/airtty/proxy.sock";
export const PROXY_PORT = 3128;

// Landlock access bits (uapi/linux/landlock.h) and the ABI that introduced each.
const FS = {
  EXECUTE: 1n << 0n,
  WRITE_FILE: 1n << 1n,
  READ_FILE: 1n << 2n,
  READ_DIR: 1n << 3n,
  REMOVE_DIR: 1n << 4n,
  REMOVE_FILE: 1n << 5n,
  MAKE_CHAR: 1n << 6n,
  MAKE_DIR: 1n << 7n,
  MAKE_REG: 1n << 8n,
  MAKE_SOCK: 1n << 9n,
  MAKE_FIFO: 1n << 10n,
  MAKE_BLOCK: 1n << 11n,
  MAKE_SYM: 1n << 12n,
  REFER: 1n << 13n, // ABI 2
  TRUNCATE: 1n << 14n, // ABI 3
  IOCTL_DEV: 1n << 15n, // ABI 5
} as const;
const NET = { BIND_TCP: 1n << 0n, CONNECT_TCP: 1n << 1n } as const; // ABI 4
const SCOPE = { ABSTRACT_UNIX_SOCKET: 1n << 0n, SIGNAL: 1n << 1n } as const; // ABI 6
const ABI_REFER = 2;
const ABI_TRUNCATE = 3;
const ABI_NET = 4;
const ABI_IOCTL = 5;
const ABI_SCOPE = 6;

const READ = FS.READ_FILE | FS.READ_DIR;
const WRITE =
  FS.WRITE_FILE |
  FS.REMOVE_DIR |
  FS.REMOVE_FILE |
  FS.MAKE_DIR |
  FS.MAKE_REG |
  FS.MAKE_SYM |
  FS.MAKE_SOCK |
  FS.MAKE_FIFO;

/** Everything this ABI can restrict: a right it does not handle is silently allowed. */
function handledFs(abi: number) {
  let bits = READ | WRITE | FS.EXECUTE | FS.MAKE_CHAR | FS.MAKE_BLOCK;
  if (abi >= ABI_REFER) bits |= FS.REFER;
  if (abi >= ABI_TRUNCATE) bits |= FS.TRUNCATE;
  if (abi >= ABI_IOCTL) bits |= FS.IOCTL_DEV;
  return bits;
}

// Syscalls denied with EPERM. None is needed by Bun or a TUI; each is a known escape or
// info-leak route from a confined process.
export const SECCOMP_DENY = [
  "ptrace",
  "process_vm_readv",
  "process_vm_writev",
  "keyctl",
  "add_key",
  "request_key",
  "bpf",
  "perf_event_open",
  "userfaultfd",
  "mount",
  "umount2",
  "pivot_root",
  "unshare",
  "setns",
  "kexec_load",
  "init_module",
  "finit_module",
  "open_by_handle_at",
] as const;
// ioctl(fd, TIOCSTI|TIOCLINUX) injects input into a terminal: denied by request number.
export const SECCOMP_IOCTL_DENY = { TIOCSTI: 0x5412, TIOCLINUX: 0x541c } as const;

export function linuxPlan(caps: Capabilities, runtime: LinuxRuntime) {
  const names = granted(caps);
  const anyHost = caps.net.includes("*");
  const hosts = caps.net.length > 0 && !anyHost;
  if (hosts && !runtime.proxySocket) throw new Error("net lists hosts: a proxy socket is required");
  const bwrap = [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    ...(anyHost ? ["--share-net"] : []),
    "--clearenv",
    // The system's shared libraries and the dynamic loader, read-only. Merged-/usr
    // distributions symlink /lib and /bin; `--ro-bind-try` covers both layouts.
    ...["/usr", "/lib", "/lib64", "/bin", "/etc/ld.so.cache", "/etc/localtime"].flatMap((p) => [
      "--ro-bind-try",
      p,
      p,
    ]),
    ...(anyHost
      ? ["/etc/resolv.conf", "/etc/hosts", "/etc/ssl"].flatMap((p) => ["--ro-bind-try", p, p])
      : []),
    "--proc",
    "/proc",
    // `--dev` brings a private devpts (and so /dev/ptmx); without `pty` only the harmless
    // character devices are bound.
    ...(caps.pty
      ? ["--dev", "/dev"]
      : ["/dev/null", "/dev/zero", "/dev/urandom", "/dev/random"].flatMap((p) => [
          "--dev-bind",
          p,
          p,
        ])),
    "--ro-bind",
    runtime.bun,
    runtime.bun,
    ...runtime.code.flatMap((p) => ["--ro-bind", p, p]),
    ...caps.fs.read.flatMap((p) => ["--ro-bind", p, p]),
    "--bind",
    runtime.tmp,
    runtime.tmp,
    ...caps.fs.write.flatMap((p) => ["--bind", p, p]),
    ...(Array.isArray(caps.exec) ? caps.exec.flatMap((p) => ["--ro-bind", p, p]) : []),
    ...(hosts && runtime.proxySocket
      ? ["--dir", dirname(PROXY_SOCKET), "--bind", runtime.proxySocket, PROXY_SOCKET]
      : []),
    "--setenv",
    "TMPDIR",
    runtime.tmp,
    "--setenv",
    "PATH",
    "/usr/bin:/bin",
    ...(hosts ? ["--setenv", "HTTP_PROXY", `http://127.0.0.1:${PROXY_PORT}`] : []),
    ...(hosts ? ["--setenv", "HTTPS_PROXY", `http://127.0.0.1:${PROXY_PORT}`] : []),
  ];

  const abi = runtime.landlockAbi;
  const fsRules: { path: string; access: bigint }[] = [
    // Libraries: read, never execute (mmap PROT_EXEC is not an execve).
    ...["/usr", "/lib", "/lib64", "/etc", "/proc", "/dev"].map((path) => ({ path, access: READ })),
    { path: runtime.bun, access: FS.READ_FILE | FS.EXECUTE },
    ...runtime.code.map((path) => ({ path, access: READ })),
    ...caps.fs.read.map((path) => ({ path, access: READ })),
    ...[runtime.tmp, ...caps.fs.write].map((path) => ({
      path,
      access: READ | WRITE | (abi >= ABI_TRUNCATE ? FS.TRUNCATE : 0n),
    })),
    ...(caps.exec === true
      ? ["/usr", "/bin"].map((path) => ({ path, access: READ | FS.EXECUTE }))
      : caps.exec === false
        ? []
        : caps.exec.map((path) => ({ path, access: FS.READ_FILE | FS.EXECUTE }))),
    ...(caps.pty && abi >= ABI_IOCTL
      ? [{ path: "/dev/pts", access: FS.IOCTL_DEV | READ | FS.WRITE_FILE }]
      : []),
    ...(caps.pty
      ? [
          {
            path: "/dev/ptmx",
            access: FS.READ_FILE | FS.WRITE_FILE | (abi >= ABI_IOCTL ? FS.IOCTL_DEV : 0n),
          },
        ]
      : []),
  ];
  // TCP by port only: Landlock cannot name a host. Inside bubblewrap's network namespace
  // only loopback exists, so "port 3128" means the relay to the host's proxy.
  const netRules =
    anyHost || abi < ABI_NET ? [] : hosts ? [{ port: PROXY_PORT, access: NET.CONNECT_TCP }] : [];
  const landlock =
    abi === 0
      ? undefined
      : {
          handledAccessFs: handledFs(abi),
          handledAccessNet: abi >= ABI_NET && !anyHost ? NET.BIND_TCP | NET.CONNECT_TCP : 0n,
          scoped: abi >= ABI_SCOPE ? SCOPE.ABSTRACT_UNIX_SOCKET | SCOPE.SIGNAL : 0n,
          fsRules,
          netRules,
        };
  const seccomp = { deny: SECCOMP_DENY, ioctlDeny: Object.values(SECCOMP_IOCTL_DENY) };

  const report: EnforcementReport = [];
  const fsBy = "os" as const;
  if (names.includes("fs.read"))
    report.push({ capability: "fs.read", by: fsBy, note: "bind mounts + Landlock" });
  if (names.includes("fs.write"))
    report.push({ capability: "fs.write", by: fsBy, note: "bind mounts + Landlock" });
  if (anyHost) report.push({ capability: "net", by: "os", note: "--share-net: any host" });
  else if (hosts)
    report.push({
      capability: "net",
      by: "proxy",
      note: "network namespace (loopback only) + proxy unix socket; the proxy checks hosts",
    });
  if (names.includes("exec"))
    report.push({
      capability: "exec",
      by: landlock ? "os" : "unenforced",
      note: landlock
        ? "Landlock EXECUTE on listed paths"
        : "no Landlock: any mounted binary can run (only mounts limit it)",
    });
  if (caps.pty) report.push({ capability: "pty", by: "os", note: "private devpts from --dev" });
  // Clipboard (Wayland/X11 sockets), notifications and secrets (D-Bus), open-url (portal):
  // none of their sockets is mounted, and abstract sockets are per network namespace.
  for (const capability of [
    "clipboard.read",
    "clipboard.write",
    "notify",
    "open-url",
    "secrets",
    "input.global",
    "tabs.message",
  ] as const)
    if (names.includes(capability))
      report.push({ capability, by: "host", note: "no socket mounted; host IPC" });
  return { bwrap, landlock, seccomp, report };
}

/**
 * Landlock without bubblewrap (no user namespaces allowed, e.g. hardened distributions):
 * TCP rules match a port on any address, and UDP is not filtered, so a host list cannot
 * be enforced. Reported as such, never shown as granted.
 */
export function landlockOnlyNet(caps: Capabilities, abi: number): EnforcementReport {
  if (!caps.net.length || caps.net.includes("*")) return [];
  const ports = [...new Set(caps.net.map((p) => parseHost(p, 0).port))];
  return [
    {
      capability: "net",
      by: "unenforced",
      note:
        abi >= ABI_NET
          ? `TCP ports ${ports.join(",")} to any address; UDP open`
          : "no network rules before ABI 4",
    },
  ];
}
