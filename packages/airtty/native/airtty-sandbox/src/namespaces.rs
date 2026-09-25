//! Unprivileged namespaces, when the system allows them (a user namespace owns the
//! others): a network namespace with only loopback (the host's proxy and Server reached
//! through relays), a mount namespace for a private devpts, PID and IPC namespaces so the
//! child sees and signals none of the user's processes.

use std::ffi::CString;
use std::fs;
use std::io;

fn check(r: libc::c_int, what: &str) -> io::Result<()> {
    if r < 0 {
        let error = io::Error::last_os_error();
        return Err(io::Error::new(error.kind(), format!("{what}: {error}")));
    }
    Ok(())
}

/// Enters new user, mount and IPC namespaces (and network when `network`), mapping this
/// user to itself. The PID namespace comes later (`enter_pid`), in another process: after
/// it, the caller could no longer start the relays' threads.
pub fn enter(network: bool) -> io::Result<()> {
    let (uid, gid) = unsafe { (libc::getuid(), libc::getgid()) };
    let mut flags = libc::CLONE_NEWUSER | libc::CLONE_NEWNS | libc::CLONE_NEWIPC;
    if network {
        flags |= libc::CLONE_NEWNET;
    }
    check(unsafe { libc::unshare(flags) }, "unshare")?;
    fs::write("/proc/self/setgroups", "deny")?;
    fs::write("/proc/self/uid_map", format!("{uid} {uid} 1"))?;
    fs::write("/proc/self/gid_map", format!("{gid} {gid} 1"))?;
    // Mounts made here never propagate back to the host.
    check(
        unsafe {
            libc::mount(
                std::ptr::null(),
                c"/".as_ptr(),
                std::ptr::null(),
                libc::MS_REC | libc::MS_PRIVATE,
                std::ptr::null(),
            )
        },
        "private mounts",
    )?;
    if network {
        loopback_up()?;
    }
    Ok(())
}

/// A PID namespace for the next fork: the child sees and signals none of the user's
/// processes (without Landlock's signal scoping, ABI 6, the user namespace alone would
/// let it, its uid being the user's).
pub fn enter_pid() -> io::Result<()> {
    check(unsafe { libc::unshare(libc::CLONE_NEWPID) }, "unshare PID")
}

/// A new network namespace starts with `lo` down.
fn loopback_up() -> io::Result<()> {
    let socket = unsafe { libc::socket(libc::AF_INET, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, 0) };
    check(socket, "socket")?;
    let mut request: libc::ifreq = unsafe { std::mem::zeroed() };
    for (i, byte) in b"lo".iter().enumerate() {
        request.ifr_name[i] = *byte as libc::c_char;
    }
    let result = (|| {
        check(
            unsafe { libc::ioctl(socket, libc::SIOCGIFFLAGS as _, &mut request) },
            "SIOCGIFFLAGS",
        )?;
        unsafe {
            request.ifr_ifru.ifru_flags |= (libc::IFF_UP | libc::IFF_RUNNING) as libc::c_short
        };
        check(
            unsafe { libc::ioctl(socket, libc::SIOCSIFFLAGS as _, &request) },
            "SIOCSIFFLAGS",
        )
    })();
    unsafe { libc::close(socket) };
    result
}

/// A devpts instance of its own on /dev/pts, and /dev/ptmx pointing to it: the child's
/// PTYs are allocated there, and the user's terminals are not in it.
pub fn private_devpts() -> io::Result<()> {
    let options = CString::new("newinstance,ptmxmode=0666,mode=0620").expect("no NUL");
    check(
        unsafe {
            libc::mount(
                c"devpts".as_ptr(),
                c"/dev/pts".as_ptr(),
                c"devpts".as_ptr(),
                libc::MS_NOSUID | libc::MS_NOEXEC,
                options.as_ptr().cast(),
            )
        },
        "mount devpts",
    )?;
    check(
        unsafe {
            libc::mount(
                c"/dev/pts/ptmx".as_ptr(),
                c"/dev/ptmx".as_ptr(),
                std::ptr::null(),
                libc::MS_BIND,
                std::ptr::null(),
            )
        },
        "bind /dev/ptmx",
    )
}

/// Whether this process may create a user namespace with a network namespace: tried in
/// a short-lived child, so this process stays where it is.
pub fn available() -> bool {
    match unsafe { libc::fork() } {
        0 => {
            let ok = enter(true).is_ok();
            unsafe { libc::_exit(if ok { 0 } else { 1 }) }
        }
        pid if pid > 0 => {
            let mut status = 0;
            unsafe { libc::waitpid(pid, &mut status, 0) };
            libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0
        }
        _ => false,
    }
}
