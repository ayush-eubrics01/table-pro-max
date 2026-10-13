//! Credential storage.
//!
//! Passwords are kept in the operating system's credential store (Keychain on macOS,
//! Credential Manager on Windows, Secret Service on Linux). When no store is available
//! the application falls back to "ask every time": secrets are held in process memory
//! for the session and never written to disk. There is deliberately no plaintext or
//! home-grown encrypted file fallback.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::error::{AppError, ErrorKind, Result};

pub const SERVICE: &str = "dev.tablepromax.app";

pub trait CredentialStore: Send + Sync {
    fn name(&self) -> &'static str;
    /// True when secrets survive an application restart.
    fn persistent(&self) -> bool;
    fn get(&self, account: &str) -> Result<Option<String>>;
    fn set(&self, account: &str, secret: &str) -> Result<()>;
    fn delete(&self, account: &str) -> Result<()>;
}

/// Credential account name for a connection's database password.
pub fn connection_account(connection_id: &str) -> String {
    format!("connection:{connection_id}:password")
}

/// Credential account name for a connection's SSH password or key passphrase.
pub fn ssh_account(connection_id: &str) -> String {
    format!("connection:{connection_id}:ssh")
}

/// In-memory store: used for "ask every time" passwords and when no OS store exists.
#[derive(Default)]
pub struct MemoryStore {
    secrets: Mutex<HashMap<String, String>>,
}

impl CredentialStore for MemoryStore {
    fn name(&self) -> &'static str {
        "session memory"
    }
    fn persistent(&self) -> bool {
        false
    }
    fn get(&self, account: &str) -> Result<Option<String>> {
        Ok(self.secrets.lock().map_err(|_| poisoned())?.get(account).cloned())
    }
    fn set(&self, account: &str, secret: &str) -> Result<()> {
        self.secrets.lock().map_err(|_| poisoned())?.insert(account.to_string(), secret.to_string());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<()> {
        self.secrets.lock().map_err(|_| poisoned())?.remove(account);
        Ok(())
    }
}

fn poisoned() -> AppError {
    AppError::new(ErrorKind::CredentialStore, "Credential store lock poisoned")
}

#[cfg(feature = "os-keyring")]
pub use os::OsKeyring;

#[cfg(feature = "os-keyring")]
mod os {
    use super::*;

    /// The platform credential store via the `keyring` crate. Calls may block on IPC
    /// (D-Bus on Linux), so callers on an async runtime should use `spawn_blocking`.
    pub struct OsKeyring;

    impl OsKeyring {
        /// Returns the store if the platform backend initialised successfully.
        pub fn detect() -> Result<Self> {
            if let Err(e) = keyring::Entry::store_status() {
                return Err(map(e));
            }
            // Initialisation can succeed without a reachable backend (e.g. no D-Bus
            // session on Linux), so probe with a read of an entry that never exists.
            match Self::entry("availability-probe")?.get_password() {
                Ok(_) | Err(keyring::Error::NoEntry) => Ok(Self),
                Err(e) => Err(map(&e)),
            }
        }

        fn entry(account: &str) -> Result<keyring::Entry> {
            keyring::Entry::new(SERVICE, account).map_err(|e| map(&e))
        }
    }

    fn map(e: &keyring::Error) -> AppError {
        AppError::new(
            ErrorKind::CredentialStore,
            "The system credential store is unavailable. Passwords will be requested when connecting.",
        )
        .with_detail(e.to_string())
    }

    impl CredentialStore for OsKeyring {
        fn name(&self) -> &'static str {
            if cfg!(target_os = "macos") {
                "macOS Keychain"
            } else if cfg!(target_os = "windows") {
                "Windows Credential Manager"
            } else {
                "Secret Service"
            }
        }
        fn persistent(&self) -> bool {
            true
        }
        fn get(&self, account: &str) -> Result<Option<String>> {
            match Self::entry(account)?.get_password() {
                Ok(s) => Ok(Some(s)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(e) => Err(map(&e)),
            }
        }
        fn set(&self, account: &str, secret: &str) -> Result<()> {
            Self::entry(account)?.set_password(secret).map_err(|e| map(&e))
        }
        fn delete(&self, account: &str) -> Result<()> {
            match Self::entry(account)?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(map(&e)),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_round_trip() {
        let s = MemoryStore::default();
        let acct = connection_account("abc");
        assert_eq!(s.get(&acct).unwrap(), None);
        s.set(&acct, "pw").unwrap();
        assert_eq!(s.get(&acct).unwrap().as_deref(), Some("pw"));
        s.delete(&acct).unwrap();
        s.delete(&acct).unwrap();
        assert_eq!(s.get(&acct).unwrap(), None);
        assert!(!s.persistent());
    }

    #[test]
    fn account_names_are_scoped() {
        assert_eq!(connection_account("id-1"), "connection:id-1:password");
        assert_eq!(ssh_account("id-1"), "connection:id-1:ssh");
    }
}
