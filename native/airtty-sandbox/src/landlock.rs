//! Landlock through its three syscalls (uapi/linux/landlock.h), no crate: the ABI is
//! small, and the exact rights handled per ABI matter (a right an ABI does not handle is
//! silently allowed, so the host must know which ABI applied).

use crate::policy::{LandlockPolicy, Network};
use std::ffi::CString;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

const SYS_CREATE_RULESET: libc::c_long = 444;
const SYS_ADD_RULE: libc::c_long = 445;
const SYS_RESTRICT_SELF: libc::c_long = 446;
const CREATE_RULESET_VERSION: u32 = 1;
const RULE_PATH_BENEATH: u32 = 1;
const RULE_NET_PORT: u32 = 2;

pub mod fs {
    pub const EXECUTE: u64 = 1 << 0;
    pub const WRITE_FILE: u64 = 1 << 1;
    pub const READ_FILE: u64 = 1 << 2;
    pub const READ_DIR: u64 = 1 << 3;
    pub const REMOVE_DIR: u64 = 1 << 4;
    pub const REMOVE_FILE: u64 = 1 << 5;
    pub const MAKE_CHAR: u64 = 1 << 6;
    pub const MAKE_DIR: u64 = 1 << 7;
    pub const MAKE_REG: u64 = 1 << 8;
    pub const MAKE_SOCK: u64 = 1 << 9;
    pub const MAKE_FIFO: u64 = 1 << 10;
    pub const MAKE_BLOCK: u64 = 1 << 11;
    pub const MAKE_SYM: u64 = 1 << 12;
    pub const REFER: u64 = 1 << 13; // ABI 2
    pub const TRUNCATE: u64 = 1 << 14; // ABI 3
    pub const IOCTL_DEV: u64 = 1 << 15; // ABI 5
}
const NET_BIND_TCP: u64 = 1 << 0; // ABI 4
const NET_CONNECT_TCP: u64 = 1 << 1;
const SCOPE_ABSTRACT_UNIX: u64 = 1 << 0; // ABI 6
const SCOPE_SIGNAL: u64 = 1 << 1;

const READ: u64 = fs::READ_FILE | fs::READ_DIR;
const WRITE: u64 = fs::WRITE_FILE
    | fs::REMOVE_DIR
    | fs::REMOVE_FILE
    | fs::MAKE_DIR
    | fs::MAKE_REG
    | fs::MAKE_SYM
    | fs::MAKE_SOCK
    | fs::MAKE_FIFO;
/// Rights that apply to a file (the others only to directories).
const FILE_RIGHTS: u64 =
    fs::EXECUTE | fs::WRITE_FILE | fs::READ_FILE | fs::TRUNCATE | fs::IOCTL_DEV;

#[repr(C)]
struct RulesetAttr {
    handled_access_fs: u64,
    handled_access_net: u64,
    scoped: u64,
}
#[repr(C, packed)]
struct PathBeneath {
    allowed_access: u64,
    parent_fd: i32,
}
#[repr(C)]
struct NetPort {
    allowed_access: u64,
    port: u64,
}

/// The kernel's Landlock ABI; 0 when Landlock is absent or disabled.
pub fn abi() -> u32 {
    let r = unsafe {
        libc::syscall(
            SYS_CREATE_RULESET,
            std::ptr::null::<RulesetAttr>(),
            0usize,
            CREATE_RULESET_VERSION,
        )
    };
    if r < 0 {
        0
    } else {
        r as u32
    }
}

/// Every filesystem right this ABI can restrict.
pub fn handled_fs(abi: u32) -> u64 {
    let mut bits = READ | WRITE | fs::EXECUTE | fs::MAKE_CHAR | fs::MAKE_BLOCK;
    if abi >= 2 {
        bits |= fs::REFER;
    }
    if abi >= 3 {
        bits |= fs::TRUNCATE;
    }
    if abi >= 5 {
        bits |= fs::IOCTL_DEV;
    }
    bits
}

struct Fd(i32);
impl Drop for Fd {
    fn drop(&mut self) {
        unsafe { libc::close(self.0) };
    }
}

fn add_path(ruleset: &Fd, path: &Path, wanted: u64, handled: u64) -> io::Result<()> {
    let c = CString::new(path.as_os_str().as_bytes())?;
    let fd = unsafe { libc::open(c.as_ptr(), libc::O_PATH | libc::O_CLOEXEC) };
    if fd < 0 {
        let error = io::Error::last_os_error();
        // A path the system does not have (/lib64 on some layouts) grants nothing.
        if error.raw_os_error() == Some(libc::ENOENT) {
            return Ok(());
        }
        return Err(io::Error::new(
            error.kind(),
            format!("{}: {error}", path.display()),
        ));
    }
    let fd = Fd(fd);
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd.0, &mut stat) } < 0 {
        return Err(io::Error::last_os_error());
    }
    let is_dir = stat.st_mode & libc::S_IFMT == libc::S_IFDIR;
    let access = wanted & handled & if is_dir { u64::MAX } else { FILE_RIGHTS };
    if access == 0 {
        return Ok(());
    }
    let rule = PathBeneath {
        allowed_access: access,
        parent_fd: fd.0,
    };
    let r = unsafe {
        libc::syscall(
            SYS_ADD_RULE,
            ruleset.0,
            RULE_PATH_BENEATH,
            &rule as *const PathBeneath,
            0u32,
        )
    };
    if r < 0 {
        let error = io::Error::last_os_error();
        return Err(io::Error::new(
            error.kind(),
            format!("rule for {}: {error}", path.display()),
        ));
    }
    Ok(())
}

/// Confines this thread (and what it execs) to `policy`; `network` decides which TCP
/// ports may be connected to. Needs no_new_privs, which the caller sets.
pub fn restrict(policy: &LandlockPolicy, network: &Network) -> io::Result<u32> {
    let abi = abi();
    if abi < policy.min_abi.max(1) {
        return Err(io::Error::other(format!(
            "Landlock ABI {abi} is below the {} the host expects",
            policy.min_abi
        )));
    }
    let handled = handled_fs(abi);
    let tcp: Option<Vec<u16>> = match network {
        Network::Open => None,
        Network::Ports { tcp } => Some(tcp.clone()),
        Network::Isolated { relays } => Some(relays.iter().map(|r| r.port).collect()),
    };
    let net = if abi >= 4 && tcp.is_some() {
        NET_BIND_TCP | NET_CONNECT_TCP
    } else {
        0
    };
    let attr = RulesetAttr {
        handled_access_fs: handled,
        handled_access_net: net,
        scoped: if abi >= 6 {
            SCOPE_ABSTRACT_UNIX | SCOPE_SIGNAL
        } else {
            0
        },
    };
    // The attribute grew with the ABI: pass the size this kernel knows.
    let size = match abi {
        1..=3 => 8,
        4 | 5 => 16,
        _ => std::mem::size_of::<RulesetAttr>(),
    };
    let fd = unsafe { libc::syscall(SYS_CREATE_RULESET, &attr as *const RulesetAttr, size, 0u32) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let ruleset = Fd(fd as i32);
    let rw = READ | WRITE | fs::TRUNCATE | fs::REFER;
    for path in &policy.read {
        add_path(&ruleset, path, READ, handled)?;
    }
    for path in &policy.list {
        add_path(&ruleset, path, fs::READ_DIR, handled)?;
    }
    for path in &policy.read_write {
        add_path(&ruleset, path, rw, handled)?;
    }
    for path in &policy.execute {
        add_path(&ruleset, path, fs::READ_FILE | fs::EXECUTE, handled)?;
    }
    for path in &policy.devices {
        add_path(
            &ruleset,
            path,
            READ | fs::WRITE_FILE | fs::IOCTL_DEV,
            handled,
        )?;
    }
    if policy.proc_self {
        add_path(&ruleset, Path::new("/proc/self"), READ, handled)?;
    }
    if net != 0 {
        for port in tcp.unwrap_or_default() {
            let rule = NetPort {
                allowed_access: NET_CONNECT_TCP,
                port: port.into(),
            };
            let r = unsafe {
                libc::syscall(
                    SYS_ADD_RULE,
                    ruleset.0,
                    RULE_NET_PORT,
                    &rule as *const NetPort,
                    0u32,
                )
            };
            if r < 0 {
                return Err(io::Error::last_os_error());
            }
        }
    }
    if unsafe { libc::syscall(SYS_RESTRICT_SELF, ruleset.0, 0u32) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(abi)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handled_rights_grow_with_the_abi() {
        assert_eq!(handled_fs(1) & fs::REFER, 0);
        assert_ne!(handled_fs(2) & fs::REFER, 0);
        assert_eq!(handled_fs(4) & fs::IOCTL_DEV, 0);
        assert_ne!(handled_fs(5) & fs::IOCTL_DEV, 0);
    }

    #[test]
    fn the_attribute_layouts_match_the_uapi() {
        assert_eq!(std::mem::size_of::<PathBeneath>(), 12);
        assert_eq!(std::mem::size_of::<NetPort>(), 16);
        assert_eq!(std::mem::size_of::<RulesetAttr>(), 24);
    }
}
