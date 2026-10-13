//! SSH tunnelling.
//!
//! A tunnel listens on `127.0.0.1:<random port>` and forwards every accepted TCP
//! connection through an SSH `direct-tcpip` channel to the database host. Database
//! drivers then connect to the local port, so secondary connections (PostgreSQL cancel
//! requests, MySQL `KILL QUERY`) travel through the same tunnel.
//!
//! Server host keys are always verified: against `~/.ssh/known_hosts` (read only) and
//! the application's own known-hosts file. An unknown host is refused with its
//! fingerprint until the user explicitly trusts it; a changed key is always refused.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client;
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKey};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use crate::error::{AppError, ErrorKind, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SshAuth {
    #[default]
    Password,
    /// Private key file, optionally protected by a passphrase.
    Key,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub auth: SshAuth,
    #[serde(default)]
    pub key_path: Option<String>,
    /// Where the SSH password or key passphrase comes from.
    #[serde(default)]
    pub secret_mode: crate::config::PasswordMode,
}

fn default_ssh_port() -> u16 {
    22
}

impl SshConfig {
    pub fn validate(&self) -> Result<()> {
        if self.host.trim().is_empty() {
            return Err(AppError::new(ErrorKind::InvalidConfig, "SSH host is required"));
        }
        if self.auth == SshAuth::Key && self.key_path.as_deref().is_none_or(|p| p.trim().is_empty()) {
            return Err(AppError::new(ErrorKind::InvalidConfig, "Choose a private key file for SSH"));
        }
        Ok(())
    }
}

/// Values resolved from `~/.ssh/config` for a host alias.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SshHostEntry {
    pub host_name: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
}

/// Minimal `ssh_config` reader: `Host` blocks with exact names, `*` or simple `prefix*`
/// patterns, and the `HostName`, `User`, `Port` and `IdentityFile` keywords. The first
/// value for each keyword wins, as in OpenSSH.
pub fn resolve_ssh_config(contents: &str, alias: &str, home: Option<&Path>) -> SshHostEntry {
    let mut entry = SshHostEntry::default();
    let mut active = false;
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => (k.trim().to_ascii_lowercase(), v.trim().trim_start_matches('=').trim()),
            None => continue,
        };
        match key.as_str() {
            "host" => {
                active = value.split_whitespace().any(|p| {
                    if let Some(prefix) = p.strip_suffix('*') { alias.starts_with(prefix) } else { p == alias }
                });
            }
            "match" => active = false,
            _ if !active => {}
            "hostname" if entry.host_name.is_none() => entry.host_name = Some(value.to_string()),
            "user" if entry.user.is_none() => entry.user = Some(value.to_string()),
            "port" if entry.port.is_none() => entry.port = value.parse().ok(),
            "identityfile" if entry.identity_file.is_none() => {
                let v = value.trim_matches('"');
                entry.identity_file = Some(match (v.strip_prefix("~/"), home) {
                    (Some(rest), Some(h)) => h.join(rest).to_string_lossy().into_owned(),
                    _ => v.to_string(),
                });
            }
            _ => {}
        }
    }
    entry
}

/// Applies `~/.ssh/config` values to fields the user left empty.
pub fn apply_ssh_config(cfg: &SshConfig) -> SshConfig {
    let Some(home) = home_dir() else { return cfg.clone() };
    let Ok(contents) = std::fs::read_to_string(home.join(".ssh").join("config")) else { return cfg.clone() };
    let e = resolve_ssh_config(&contents, &cfg.host, Some(&home));
    let mut out = cfg.clone();
    if let Some(h) = e.host_name {
        out.host = h;
    }
    if out.user.is_empty()
        && let Some(u) = e.user
    {
        out.user = u;
    }
    if cfg.port == 22
        && let Some(p) = e.port
    {
        out.port = p;
    }
    if out.auth == SshAuth::Key && out.key_path.as_deref().is_none_or(str::is_empty) {
        out.key_path = e.identity_file;
    }
    out
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
}

pub fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

/// Known-hosts policy: the user's OpenSSH file (read only) plus the app's own file.
#[derive(Debug, Clone)]
pub struct KnownHosts {
    pub app_file: PathBuf,
    pub user_file: Option<PathBuf>,
}

impl KnownHosts {
    pub fn new(app_file: PathBuf) -> Self {
        Self { app_file, user_file: home_dir().map(|h| h.join(".ssh").join("known_hosts")) }
    }

    fn check(&self, host: &str, port: u16, key: &PublicKey) -> HostKeyStatus {
        // Compare key material only; comments are not part of a host's identity.
        let key = &PublicKey::new(key.key_data().clone(), "");
        let mut files: Vec<&Path> = vec![self.app_file.as_path()];
        if let Some(u) = &self.user_file {
            files.push(u.as_path());
        }
        for f in files {
            if !f.exists() {
                continue;
            }
            match russh::keys::check_known_hosts_path(host, port, key, f) {
                Ok(true) => return HostKeyStatus::Trusted,
                Ok(false) => {}
                Err(russh::keys::Error::KeyChanged { line }) => {
                    return HostKeyStatus::Changed { file: f.display().to_string(), line };
                }
                Err(_) => {}
            }
        }
        HostKeyStatus::Unknown
    }

    /// Records a key the user chose to trust in the app's own file.
    pub fn trust(&self, host: &str, port: u16, key: &PublicKey) -> Result<()> {
        let key = PublicKey::new(key.key_data().clone(), "");
        russh::keys::known_hosts::learn_known_hosts_path(host, port, &key, &self.app_file)
            .map_err(|e| AppError::new(ErrorKind::Ssh, format!("Could not save the host key: {e}")))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum HostKeyStatus {
    Trusted,
    Unknown,
    Changed { file: String, line: usize },
}

struct Verifier {
    host: String,
    port: u16,
    known: KnownHosts,
    /// The key the server presented and the verdict, read after a failed handshake.
    seen: Arc<Mutex<Option<(PublicKey, HostKeyStatus)>>>,
}

impl client::Handler for Verifier {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        presented: &russh::keys::PublicKeyOrCertificate,
    ) -> std::result::Result<bool, Self::Error> {
        // Host certificates are checked by their underlying key, like plain host keys.
        let key = match presented {
            russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            russh::keys::PublicKeyOrCertificate::Certificate(cert) => PublicKey::new(cert.public_key().clone(), ""),
        };
        let key = &key;
        let status = self.known.check(&self.host, self.port, key);
        let ok = status == HostKeyStatus::Trusted;
        *self.seen.lock().unwrap_or_else(|p| p.into_inner()) = Some((key.clone(), status));
        Ok(ok)
    }
}

/// An open tunnel. Dropping it stops forwarding and closes the SSH connection.
pub struct Tunnel {
    pub local_port: u16,
    accept_task: JoinHandle<()>,
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.accept_task.abort();
    }
}

/// Opens an SSH connection and starts forwarding a local port to `target_host:target_port`
/// (as seen from the SSH server).
pub async fn open_tunnel(
    cfg: &SshConfig,
    secret: Option<&str>,
    target_host: &str,
    target_port: u16,
    known: KnownHosts,
    timeout: Duration,
) -> Result<Tunnel> {
    let cfg = apply_ssh_config(cfg);
    cfg.validate()?;
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 4,
        inactivity_timeout: None,
        ..Default::default()
    });
    let seen = Arc::new(Mutex::new(None));
    let verifier = Verifier { host: cfg.host.clone(), port: cfg.port, known, seen: seen.clone() };

    let connect = client::connect(config, (cfg.host.as_str(), cfg.port), verifier);
    let mut handle = match tokio::time::timeout(timeout, connect).await {
        Err(_) => {
            return Err(AppError::new(
                ErrorKind::Ssh,
                format!("SSH connection timed out after {}s", timeout.as_secs()),
            ));
        }
        Ok(Ok(h)) => h,
        Ok(Err(e)) => {
            let seen = seen.lock().unwrap_or_else(|p| p.into_inner()).clone();
            return Err(match seen {
                Some((key, HostKeyStatus::Unknown)) => AppError::new(
                    ErrorKind::Ssh,
                    format!("The SSH host {}:{} is not known. Verify its fingerprint before trusting it.", cfg.host, cfg.port),
                )
                .with_code("ssh_unknown_host")
                .with_detail(format!(
                    "{}\n{}\n{}:{}",
                    fingerprint(&key),
                    key.to_openssh().unwrap_or_default(),
                    cfg.host,
                    cfg.port
                )),
                Some((key, HostKeyStatus::Changed { file, line })) => AppError::new(
                    ErrorKind::Ssh,
                    format!(
                        "The SSH host key for {} has CHANGED (known_hosts {file}, line {line}). This can mean someone is intercepting the connection. Connection refused.",
                        cfg.host
                    ),
                )
                .with_code("ssh_host_key_changed")
                .with_detail(fingerprint(&key)),
                _ => AppError::new(ErrorKind::Ssh, format!("SSH connection failed: {e}")),
            });
        }
    };

    let user = if cfg.user.is_empty() { std::env::var("USER").unwrap_or_default() } else { cfg.user.clone() };
    let authenticated = match cfg.auth {
        SshAuth::Password => {
            let pw = secret.ok_or_else(|| {
                AppError::new(ErrorKind::Ssh, "Enter the SSH password").with_code("ssh_secret_required")
            })?;
            handle.authenticate_password(&user, pw).await.map_err(ssh_err)?
        }
        SshAuth::Key => {
            let path = cfg.key_path.clone().unwrap_or_default();
            let key = match russh::keys::load_secret_key(&path, secret) {
                Ok(k) => k,
                Err(russh::keys::Error::KeyIsEncrypted) => {
                    return Err(AppError::new(ErrorKind::Ssh, "The SSH key is encrypted; enter its passphrase")
                        .with_code("ssh_secret_required"));
                }
                Err(e) => return Err(AppError::new(ErrorKind::Ssh, format!("Cannot load SSH key {path}: {e}"))),
            };
            let hash = handle.best_supported_rsa_hash().await.map_err(ssh_err)?.flatten();
            handle
                .authenticate_publickey(&user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await
                .map_err(ssh_err)?
        }
    };
    if !authenticated.success() {
        return Err(AppError::new(
            ErrorKind::Authentication,
            format!("SSH authentication failed for {user}@{}", cfg.host),
        ));
    }

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| AppError::new(ErrorKind::Ssh, format!("Cannot open a local port for the tunnel: {e}")))?;
    let local_port = listener.local_addr().map_err(|e| AppError::internal(e.to_string()))?.port();
    let handle = Arc::new(handle);
    let target_host = target_host.to_string();
    let accept_task = tokio::spawn(async move {
        loop {
            let Ok((mut socket, peer)) = listener.accept().await else { break };
            let handle = handle.clone();
            let target_host = target_host.clone();
            tokio::spawn(async move {
                let channel = match handle
                    .channel_open_direct_tcpip(
                        target_host,
                        target_port as u32,
                        peer.ip().to_string(),
                        peer.port() as u32,
                    )
                    .await
                {
                    Ok(c) => c,
                    Err(e) => {
                        tracing::warn!(error = %e, "ssh: could not open forwarding channel");
                        return;
                    }
                };
                let mut stream = channel.into_stream();
                let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
            });
        }
    });
    Ok(Tunnel { local_port, accept_task })
}

fn ssh_err(e: russh::Error) -> AppError {
    AppError::new(ErrorKind::Ssh, format!("SSH error: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONFIG: &str = "
# comment
Host bastion
    HostName bastion.example.com
    User deploy
    Port 2222
    IdentityFile ~/.ssh/deploy_ed25519

Host db-*
    User dbadmin

Host *
    User fallback
    Port 22
";

    #[test]
    fn resolves_aliases_and_patterns() {
        let home = Path::new("/home/me");
        let e = resolve_ssh_config(CONFIG, "bastion", Some(home));
        assert_eq!(e.host_name.as_deref(), Some("bastion.example.com"));
        assert_eq!(e.user.as_deref(), Some("deploy"));
        assert_eq!(e.port, Some(2222));
        assert_eq!(e.identity_file.as_deref(), Some("/home/me/.ssh/deploy_ed25519"));

        let e = resolve_ssh_config(CONFIG, "db-eu", Some(home));
        assert_eq!(e.user.as_deref(), Some("dbadmin"), "first match wins");
        assert_eq!(e.host_name, None);

        let e = resolve_ssh_config(CONFIG, "other", Some(home));
        assert_eq!(e.user.as_deref(), Some("fallback"));
    }

    #[test]
    fn validates_config() {
        let mut c = SshConfig {
            host: "h".into(),
            port: 22,
            user: "u".into(),
            auth: SshAuth::Key,
            key_path: None,
            secret_mode: Default::default(),
        };
        assert!(c.validate().is_err());
        c.key_path = Some("/k".into());
        assert!(c.validate().is_ok());
        c.host = " ".into();
        assert!(c.validate().is_err());
    }

    #[test]
    fn known_hosts_trust_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let known = KnownHosts { app_file: dir.path().join("known_hosts"), user_file: None };
        let key = PublicKey::from_openssh(
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICUtoQQEaySZOV0R/7zfnpNsCLIQvMNHD75/6mGHpRiJ test1",
        )
        .unwrap();
        assert_eq!(known.check("db.example", 22, &key), HostKeyStatus::Unknown);
        known.trust("db.example", 22, &key).unwrap();
        assert_eq!(known.check("db.example", 22, &key), HostKeyStatus::Trusted);
        // A different key of the same type for the same host is a change, not a new host.
        let other = PublicKey::from_openssh(
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJwcOSJ5GF7lOawMAPFmPC+UtTIrSP+4RVZPl/Oq5H7E test2",
        )
        .unwrap();
        assert!(matches!(known.check("db.example", 22, &other), HostKeyStatus::Changed { .. }));
        assert!(fingerprint(&key).starts_with("SHA256:"));
    }
}
