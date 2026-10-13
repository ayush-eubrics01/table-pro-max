//! Application state shared by all commands.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use tpm_core::config::{ConnectionProfile, PasswordMode};
use tpm_core::credentials::{CredentialStore, MemoryStore, connection_account, ssh_account};
use tpm_core::engine::Engine;
use tpm_core::error::{AppError, ErrorKind, Result};
use tpm_core::storage::Storage;

pub struct AppState {
    pub engine: Arc<Engine>,
    pub storage: Arc<Storage>,
    /// The OS credential store, if one is available on this system.
    pub keyring: Option<Arc<dyn CredentialStore>>,
    /// Passwords entered for "ask every time" connections, kept for this run only.
    pub session_secrets: Arc<MemoryStore>,
    pub data_dir: PathBuf,
    pub log_dir: PathBuf,
    /// Cancellation flags of running import/export jobs.
    pub jobs: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Cancellation tokens of in-flight AI requests.
    pub ai_jobs: Mutex<HashMap<String, Arc<tokio_util::sync::CancellationToken>>>,
    /// The update found by the last check, waiting for "Update now".
    pub pending_update: Mutex<Option<tauri_plugin_updater::Update>>,
    /// Cancellation tokens of running update downloads (at most one).
    pub update_jobs: Mutex<HashMap<String, Arc<tokio_util::sync::CancellationToken>>>,
    /// Held from "Update now" until the installer returns: one install at a time.
    pub update_lock: tpm_core::updates::InstallLock,
}

impl AppState {
    pub fn credential_store_name(&self) -> &'static str {
        self.keyring.as_ref().map_or("unavailable", |k| k.name())
    }

    /// Runs a blocking keyring call off the async runtime.
    pub async fn keyring_call<T, F>(&self, f: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&dyn CredentialStore) -> Result<T> + Send + 'static,
    {
        let store = self.keyring.clone().ok_or_else(|| {
            AppError::new(
                ErrorKind::CredentialStore,
                "No system credential store is available. Choose \"Ask every time\" for the password.",
            )
        })?;
        tokio::task::spawn_blocking(move || f(store.as_ref())).await.map_err(|e| AppError::internal(e.to_string()))?
    }

    /// Resolves the password for a profile: explicit value, then this session's memory,
    /// then the OS store. Returns `password_required` when one is needed but unknown.
    pub async fn resolve_password(
        &self,
        profile: &ConnectionProfile,
        explicit: Option<String>,
    ) -> Result<Option<String>> {
        if let Some(p) = explicit {
            return Ok(Some(p));
        }
        let account = connection_account(&profile.id);
        if let Some(p) = self.session_secrets.get(&account)? {
            return Ok(Some(p));
        }
        match profile.password_mode {
            PasswordMode::None => Ok(None),
            PasswordMode::Ask => Err(password_required(profile)),
            PasswordMode::Keychain => {
                let found = self.keyring_call(move |k| k.get(&account)).await;
                match found {
                    Ok(Some(p)) => Ok(Some(p)),
                    Ok(None) => Err(password_required(profile)),
                    Err(e) => Err(e.with_code("password_required")),
                }
            }
        }
    }
}

impl AppState {
    /// Resolves the SSH password or key passphrase, following the tunnel's secret mode.
    pub async fn resolve_ssh_secret(
        &self,
        profile: &ConnectionProfile,
        explicit: Option<String>,
    ) -> Result<Option<String>> {
        let Some(ssh) = &profile.ssh else { return Ok(None) };
        if let Some(s) = explicit {
            return Ok(Some(s));
        }
        let account = ssh_account(&profile.id);
        if let Some(s) = self.session_secrets.get(&account)? {
            return Ok(Some(s));
        }
        match ssh.secret_mode {
            PasswordMode::None => Ok(None),
            PasswordMode::Ask => Err(ssh_secret_required(profile)),
            PasswordMode::Keychain => match self.keyring_call(move |k| k.get(&account)).await {
                Ok(Some(s)) => Ok(Some(s)),
                Ok(None) => Err(ssh_secret_required(profile)),
                Err(e) => Err(e.with_code("ssh_secret_required")),
            },
        }
    }
}

fn ssh_secret_required(profile: &ConnectionProfile) -> AppError {
    let what = match profile.ssh.as_ref().map(|s| s.auth) {
        Some(tpm_core::ssh::SshAuth::Key) => "SSH key passphrase",
        _ => "SSH password",
    };
    AppError::new(ErrorKind::Authentication, format!("Enter the {what} for {}", profile.name))
        .with_code("ssh_secret_required")
}

fn password_required(profile: &ConnectionProfile) -> AppError {
    AppError::new(ErrorKind::Authentication, format!("Enter the password for {}", profile.name))
        .with_code("password_required")
}
