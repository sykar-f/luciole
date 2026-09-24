//! The policy the host sends (src/sandbox/linux.ts), as JSON in one argument: parsed
//! strictly (unknown fields refused) and validated before anything is applied. Nothing in
//! it reaches a shell; paths are opened as paths, the program is exec'd as argv.

use serde::Deserialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

pub const VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Policy {
    pub version: u32,
    /// Create the user, mount, PID and IPC namespaces here (and the network one when the
    /// network is `isolated`). False when bubblewrap made them already, or when the
    /// system allows none.
    pub namespaces: bool,
    pub network: Network,
    /// A private devpts instance on /dev/pts (the `pty` capability): the child's own
    /// pseudo-terminals, and none of the user's. Requires `namespaces`.
    pub devpts: bool,
    /// Absent: no Landlock (bubblewrap's mounts confine the files).
    pub landlock: Option<LandlockPolicy>,
    pub seccomp: SeccompPolicy,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase", tag = "mode")]
pub enum Network {
    /// Any host (`net: *`): nothing filtered.
    Open,
    /// No network namespace: TCP connect only to these ports (Landlock ABI >= 4), any
    /// address. What the host shows the user says exactly that.
    Ports { tcp: Vec<u16> },
    /// A network namespace with only loopback, where each relay listens on
    /// 127.0.0.1:`port` and forwards to a Unix socket of the host (its egress proxy, the
    /// application's Server).
    Isolated { relays: Vec<Relay> },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Relay {
    pub port: u16,
    pub socket: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LandlockPolicy {
    /// Refuse to run below this ABI rather than confine less than the host announced.
    pub min_abi: u32,
    pub read: Vec<PathBuf>,
    /// Directories whose entries may be listed, not their files read (the directory that
    /// holds node_modules: Bun's resolver lists it).
    pub list: Vec<PathBuf>,
    pub read_write: Vec<PathBuf>,
    /// Binaries the child may execve (the runtime itself included).
    pub execute: Vec<PathBuf>,
    /// Devices opened read-write with ioctls (the child's own PTYs: /dev/ptmx, /dev/pts).
    pub devices: Vec<PathBuf>,
    /// Read the child's own /proc/<pid>, resolved after the fork.
    pub proc_self: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SeccompPolicy {
    /// Refuse UDP sockets: without a network namespace, Landlock does not filter UDP.
    pub deny_udp: bool,
}

fn check_path(path: &Path) -> Result<(), String> {
    let text = path
        .to_str()
        .ok_or_else(|| format!("{path:?}: not UTF-8"))?;
    if !path.is_absolute() || text.contains('\0') {
        return Err(format!("{text}: expected an absolute path"));
    }
    // Path::components() drops "." segments: check the text itself.
    if text
        .split('/')
        .any(|segment| segment == "." || segment == "..")
    {
        return Err(format!("{text}: no . or .. components"));
    }
    Ok(())
}

impl Policy {
    pub fn parse(text: &str) -> Result<Policy, String> {
        let policy: Policy = serde_json::from_str(text).map_err(|e| format!("policy: {e}"))?;
        policy.validate()?;
        Ok(policy)
    }

    fn validate(&self) -> Result<(), String> {
        if self.version != VERSION {
            return Err(format!(
                "policy version {} (expected {VERSION})",
                self.version
            ));
        }
        if self.devpts && !self.namespaces {
            return Err("a private devpts needs namespaces".into());
        }
        match &self.network {
            Network::Ports { tcp } => {
                if tcp.contains(&0) {
                    return Err("port 0".into());
                }
                if self.landlock.is_none() {
                    return Err("ports without a network namespace need Landlock".into());
                }
            }
            Network::Isolated { relays } => {
                let mut ports = BTreeSet::new();
                for relay in relays {
                    check_path(&relay.socket)?;
                    if relay.port == 0 || !ports.insert(relay.port) {
                        return Err(format!("relay port {} (zero or twice)", relay.port));
                    }
                }
            }
            Network::Open => {}
        }
        if let Some(landlock) = &self.landlock {
            for path in landlock
                .read
                .iter()
                .chain(&landlock.list)
                .chain(&landlock.read_write)
                .chain(&landlock.execute)
                .chain(&landlock.devices)
            {
                check_path(path)?;
            }
        }
        Ok(())
    }
}

/// argv to exec: absolute program, no NUL anywhere.
pub fn check_argv(argv: &[String]) -> Result<(), String> {
    let program = argv.first().ok_or("nothing to run after --")?;
    check_path(Path::new(program))?;
    if argv.iter().any(|a| a.contains('\0')) {
        return Err("argv holds a NUL byte".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = r#"{"version":1,"namespaces":false,"network":{"mode":"ports","tcp":[3000]},"devpts":false,"landlock":{"minAbi":4,"read":["/usr"],"list":[],"readWrite":["/tmp/x"],"execute":["/usr/bin/bun"],"devices":[],"procSelf":true},"seccomp":{"denyUdp":true}}"#;

    #[test]
    fn a_valid_policy_parses() {
        let policy = Policy::parse(BASE).unwrap();
        assert!(matches!(policy.network, Network::Ports { ref tcp } if tcp == &[3000]));
    }

    #[test]
    fn unknown_fields_and_versions_are_refused() {
        assert!(
            Policy::parse(&BASE.replace(r#""devpts":false"#, r#""devpts":false,"extra":1"#))
                .is_err()
        );
        assert!(Policy::parse(&BASE.replace(r#""version":1"#, r#""version":2"#)).is_err());
    }

    #[test]
    fn paths_must_be_absolute_and_plain() {
        for bad in ["usr", "/usr/../etc", "/usr/./lib"] {
            let text = BASE.replace(r#""read":["/usr"]"#, &format!(r#""read":["{bad}"]"#));
            assert!(Policy::parse(&text).is_err(), "{bad} accepted");
        }
    }

    #[test]
    fn inconsistent_policies_are_refused() {
        assert!(Policy::parse(&BASE.replace(r#""devpts":false"#, r#""devpts":true"#)).is_err());
        assert!(Policy::parse(&BASE.replace(r#""tcp":[3000]"#, r#""tcp":[0]"#)).is_err());
        let relays =
            r#"{"mode":"isolated","relays":[{"port":1,"socket":"/a"},{"port":1,"socket":"/b"}]}"#;
        assert!(Policy::parse(&BASE.replace(r#"{"mode":"ports","tcp":[3000]}"#, relays)).is_err());
        let no_landlock = BASE.split(r#","landlock""#).next().unwrap().to_owned()
            + r#","landlock":null,"seccomp":{"denyUdp":true}}"#;
        assert!(Policy::parse(&no_landlock).is_err());
    }

    #[test]
    fn argv_is_absolute() {
        assert!(check_argv(&["bun".into()]).is_err());
        assert!(check_argv(&[]).is_err());
        assert!(check_argv(&["/usr/bin/bun".into(), "x".into()]).is_ok());
    }
}
