//! luciole-sandbox: the Linux side of luciole's `sandbox` mode (docs/EMBEDDING.md, decision
//! 6). The host (src/sandbox/linux.ts) starts it on the PTY of a VT widget:
//!
//!   luciole-sandbox --policy '<json>' -- /abs/bun child.js …   confine, then exec
//!   luciole-sandbox --probe                                    what this system allows
//!
//! It applies, in order: namespaces (when the policy asks and the system allows), the
//! network relays, Landlock, seccomp, then execs the child, which inherits all of them.
//! With namespaces or relays it forks: the parent stays as the child's supervisor (relays,
//! signals, exit status) and holds none of its descriptors.

mod landlock;
mod namespaces;
mod policy;
mod relay;
mod seccomp;

use policy::{check_argv, Network, Policy};
use std::ffi::CString;
use std::io;
use std::net::TcpListener;
use std::os::fd::AsRawFd;
use std::sync::atomic::{AtomicI32, Ordering};

/// Exit status when the sandbox could not be set up (as env(1) and chroot(1) do).
const SETUP_FAILED: i32 = 125;
const SIGNAL_EXIT_BASE: i32 = 128;

fn fail(message: impl std::fmt::Display) -> ! {
    eprintln!("luciole-sandbox: {message}");
    std::process::exit(SETUP_FAILED)
}

fn probe() {
    println!(
        r#"{{"version":{},"landlockAbi":{},"userNamespaces":{}}}"#,
        policy::VERSION,
        landlock::abi(),
        namespaces::available()
    );
}

fn confine_and_exec(policy: &Policy, argv: &[String]) -> ! {
    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0 {
        fail(format!("no_new_privs: {}", io::Error::last_os_error()));
    }
    if let Some(rules) = &policy.landlock {
        if let Err(error) = landlock::restrict(rules, &policy.network) {
            fail(format!("Landlock: {error}"));
        }
    }
    if let Err(error) = seccomp::apply(&policy.seccomp) {
        fail(format!("seccomp: {error}"));
    }
    let args: Vec<CString> = argv
        .iter()
        .map(|a| CString::new(a.as_str()).expect("checked"))
        .collect();
    let mut pointers: Vec<*const libc::c_char> = args.iter().map(|a| a.as_ptr()).collect();
    pointers.push(std::ptr::null());
    // The environment is the host's choice already (it started this process with it).
    unsafe { libc::execv(pointers[0], pointers.as_ptr()) };
    fail(format!("exec {}: {}", argv[0], io::Error::last_os_error()))
}

static CHILD: AtomicI32 = AtomicI32::new(0);
extern "C" fn forward(signal: libc::c_int) {
    let child = CHILD.load(Ordering::SeqCst);
    if child > 0 {
        unsafe { libc::kill(child, signal) };
    }
}

/// Closes every descriptor but stdio and `keep`: the IPC channel and the PTY's other
/// descriptors belong to the child, whose end the host must see when it ends.
fn close_others(keep: &[i32]) {
    let open: Vec<i32> = match std::fs::read_dir("/proc/self/fd") {
        Ok(entries) => entries
            .flatten()
            .filter_map(|e| e.file_name().to_str()?.parse().ok())
            .collect(),
        Err(_) => return,
    };
    for fd in open {
        if fd > 2 && !keep.contains(&fd) {
            unsafe { libc::close(fd) };
        }
    }
}

/// The parent: forwards the host's signals, relays, and exits as the child did.
fn supervise(child: libc::pid_t, listeners: Vec<(TcpListener, std::path::PathBuf)>) -> ! {
    CHILD.store(child, Ordering::SeqCst);
    unsafe {
        for signal in [
            libc::SIGHUP,
            libc::SIGTERM,
            libc::SIGQUIT,
            libc::SIGUSR1,
            libc::SIGUSR2,
        ] {
            libc::signal(signal, forward as *const () as libc::sighandler_t);
        }
        // Typed in the terminal, it reaches the child's process group already.
        libc::signal(libc::SIGINT, libc::SIG_IGN);
    }
    close_others(
        &listeners
            .iter()
            .map(|(l, _)| l.as_raw_fd())
            .collect::<Vec<_>>(),
    );
    for (listener, socket) in listeners {
        relay::serve(listener, socket);
    }
    let mut status = 0;
    loop {
        let r = unsafe { libc::waitpid(child, &mut status, 0) };
        if r == child {
            break;
        }
        if r < 0 && io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            std::process::exit(SETUP_FAILED);
        }
    }
    if libc::WIFSIGNALED(status) {
        std::process::exit(SIGNAL_EXIT_BASE + libc::WTERMSIG(status));
    }
    std::process::exit(libc::WEXITSTATUS(status))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--probe") => return probe(),
        Some("--policy") => {}
        _ => fail("usage: luciole-sandbox --policy <json> -- <argv…> | --probe"),
    }
    let text = args
        .get(1)
        .unwrap_or_else(|| fail("--policy needs its JSON"));
    if args.get(2).map(String::as_str) != Some("--") {
        fail("expected -- before the program");
    }
    let argv = &args[3..];
    let policy = Policy::parse(text).unwrap_or_else(|e| fail(e));
    check_argv(argv).unwrap_or_else(|e| fail(e));
    let isolated = matches!(policy.network, Network::Isolated { .. });
    if policy.namespaces {
        namespaces::enter(isolated).unwrap_or_else(|e| fail(format!("namespaces: {e}")));
        if policy.devpts {
            namespaces::private_devpts().unwrap_or_else(|e| fail(format!("devpts: {e}")));
        }
    }
    let listeners = match &policy.network {
        Network::Isolated { relays } => relays
            .iter()
            .map(|r| relay::listen(r.port).map(|l| (l, r.socket.clone())))
            .collect::<io::Result<Vec<_>>>()
            .unwrap_or_else(|e| fail(e)),
        _ => vec![],
    };
    // A PID namespace takes effect for the next child; relays need a process of their own.
    if !policy.namespaces && listeners.is_empty() {
        confine_and_exec(&policy, argv);
    }
    match unsafe { libc::fork() } {
        0 => {
            drop(listeners);
            if !policy.namespaces {
                confine_and_exec(&policy, argv)
            }
            // supervisor → this intermediate process → the child, PID 1 of its namespace.
            namespaces::enter_pid().unwrap_or_else(|e| fail(format!("namespaces: {e}")));
            match unsafe { libc::fork() } {
                0 => confine_and_exec(&policy, argv),
                pid if pid > 0 => supervise(pid, vec![]),
                _ => fail(format!("fork: {}", io::Error::last_os_error())),
            }
        }
        pid if pid > 0 => supervise(pid, listeners),
        _ => fail(format!("fork: {}", io::Error::last_os_error())),
    }
}
