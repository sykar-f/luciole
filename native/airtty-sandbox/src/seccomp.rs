//! Syscalls a confined Client never needs, refused (EPERM) by a seccomp filter the child
//! inherits across exec. Each entry closes a route Landlock and the namespaces leave open:
//!
//! - `socket(AF_UNIX)`: Landlock does not restrict connecting to a named Unix socket
//!   (measured on Linux 7.0, ABI 8): the session bus, Wayland and X11 would be reachable,
//!   hence notifications, secrets, the clipboard and keystrokes, all of which the host
//!   mediates. The IPC channel is inherited and socketpair() stays allowed.
//! - `socket(AF_NETLINK | AF_PACKET)`, UDP when there is no network namespace (Landlock
//!   filters TCP only).
//! - `ioctl(TIOCSTI | TIOCLINUX)`: typing into a terminal.
//! - `ptrace`, `process_vm_*`: other processes' memory.
//! - `io_uring_*`: its operations (socket, connect, open) would not pass this filter.
//! - namespaces and mounts (`unshare`, `setns`, `mount`…, `clone` with CLONE_NEW*):
//!   `clone3` answers ENOSYS, so libc falls back to `clone`, whose flags are visible.
//! - keyrings, `bpf`, `perf_event_open`, `userfaultfd`, modules, `kexec`,
//!   `open_by_handle_at`: kernel surface a TUI does not use.

use crate::policy::SeccompPolicy;
use seccompiler::{
    apply_filter, BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition,
    SeccompFilter, SeccompRule, TargetArch,
};
use std::collections::BTreeMap;
use std::io;

const TIOCSTI: u64 = 0x5412;
const TIOCLINUX: u64 = 0x541c;
const SOCK_TYPE_MASK: u64 = 0xf;
const NAMESPACE_FLAGS: [u64; 7] = [
    libc::CLONE_NEWUSER as u64,
    libc::CLONE_NEWNS as u64,
    libc::CLONE_NEWNET as u64,
    libc::CLONE_NEWPID as u64,
    libc::CLONE_NEWIPC as u64,
    libc::CLONE_NEWUTS as u64,
    libc::CLONE_NEWCGROUP as u64,
];

#[cfg(target_arch = "x86_64")]
const ARCH: TargetArch = TargetArch::x86_64;
#[cfg(target_arch = "aarch64")]
const ARCH: TargetArch = TargetArch::aarch64;

fn eq(arg: u8, value: u64) -> SeccompCondition {
    SeccompCondition::new(arg, SeccompCmpArgLen::Dword, SeccompCmpOp::Eq, value).expect("condition")
}
fn has_bits(arg: u8, mask: u64) -> SeccompCondition {
    SeccompCondition::new(
        arg,
        SeccompCmpArgLen::Qword,
        SeccompCmpOp::MaskedEq(mask),
        mask,
    )
    .expect("condition")
}
fn rule(conditions: Vec<SeccompCondition>) -> SeccompRule {
    SeccompRule::new(conditions).expect("rule")
}

pub const DENIED: &[libc::c_long] = &[
    libc::SYS_ptrace,
    libc::SYS_process_vm_readv,
    libc::SYS_process_vm_writev,
    libc::SYS_keyctl,
    libc::SYS_add_key,
    libc::SYS_request_key,
    libc::SYS_bpf,
    libc::SYS_perf_event_open,
    libc::SYS_userfaultfd,
    libc::SYS_mount,
    libc::SYS_umount2,
    libc::SYS_pivot_root,
    libc::SYS_unshare,
    libc::SYS_setns,
    libc::SYS_kexec_load,
    libc::SYS_init_module,
    libc::SYS_finit_module,
    libc::SYS_open_by_handle_at,
    libc::SYS_io_uring_setup,
    libc::SYS_io_uring_enter,
    libc::SYS_io_uring_register,
    libc::SYS_fsopen,
    libc::SYS_fsmount,
    libc::SYS_move_mount,
    libc::SYS_open_tree,
];

/// The filter refusing with EPERM, then the one answering ENOSYS to `clone3`.
pub fn programs(policy: &SeccompPolicy) -> Result<[BpfProgram; 2], String> {
    let mut rules: BTreeMap<i64, Vec<SeccompRule>> = DENIED.iter().map(|&s| (s, vec![])).collect();
    let mut socket = vec![
        rule(vec![eq(0, libc::AF_UNIX as u64)]),
        rule(vec![eq(0, libc::AF_NETLINK as u64)]),
        rule(vec![eq(0, libc::AF_PACKET as u64)]),
    ];
    if policy.deny_udp {
        for domain in [libc::AF_INET, libc::AF_INET6] {
            socket.push(rule(vec![
                eq(0, domain as u64),
                SeccompCondition::new(
                    1,
                    SeccompCmpArgLen::Dword,
                    SeccompCmpOp::MaskedEq(SOCK_TYPE_MASK),
                    libc::SOCK_DGRAM as u64,
                )
                .expect("condition"),
            ]));
        }
    }
    rules.insert(libc::SYS_socket, socket);
    rules.insert(
        libc::SYS_ioctl,
        vec![rule(vec![eq(1, TIOCSTI)]), rule(vec![eq(1, TIOCLINUX)])],
    );
    rules.insert(
        libc::SYS_clone,
        NAMESPACE_FLAGS
            .iter()
            .map(|&flag| rule(vec![has_bits(0, flag)]))
            .collect(),
    );
    let deny = SeccompFilter::new(
        rules,
        SeccompAction::Allow,
        SeccompAction::Errno(libc::EPERM as u32),
        ARCH,
    )
    .map_err(|e| e.to_string())?;
    let clone3 = SeccompFilter::new(
        [(libc::SYS_clone3, vec![])].into_iter().collect(),
        SeccompAction::Allow,
        SeccompAction::Errno(libc::ENOSYS as u32),
        ARCH,
    )
    .map_err(|e| e.to_string())?;
    Ok([
        deny.try_into()
            .map_err(|e: seccompiler::BackendError| e.to_string())?,
        clone3
            .try_into()
            .map_err(|e: seccompiler::BackendError| e.to_string())?,
    ])
}

pub fn apply(policy: &SeccompPolicy) -> io::Result<()> {
    for program in programs(policy).map_err(io::Error::other)? {
        apply_filter(&program).map_err(|e| io::Error::other(e.to_string()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_filters_compile_for_this_architecture() {
        let [deny, clone3] = programs(&SeccompPolicy { deny_udp: true }).unwrap();
        assert!(deny.len() > DENIED.len());
        assert!(!clone3.is_empty());
    }
}
