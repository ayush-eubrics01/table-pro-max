//! Structured error model shared by every layer.
//!
//! Every error carries a category (`ErrorKind`), a user-facing message that is safe to
//! display, and optional diagnostic detail. Both strings are passed through
//! [`crate::redact::redact`] at construction time so secrets embedded in driver errors
//! (for example a connection URL echoed back) never reach the UI or the logs.

use serde::Serialize;

use crate::redact::redact;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    InvalidConfig,
    Authentication,
    Network,
    Tls,
    Ssh,
    Database,
    Timeout,
    Cancelled,
    Constraint,
    Conflict,
    Serialization,
    File,
    CredentialStore,
    Unsupported,
    PolicyViolation,
    ConfirmationRequired,
    NotFound,
    Internal,
}

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Database-specific error code (SQLSTATE for PostgreSQL, error number for MySQL).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// 1-based character position in the submitted SQL, when the server reports one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<u32>,
}

pub type Result<T, E = AppError> = std::result::Result<T, E>;

impl AppError {
    pub fn new(kind: ErrorKind, message: impl AsRef<str>) -> Self {
        Self { kind, message: redact(message.as_ref()), detail: None, code: None, position: None }
    }

    pub fn with_detail(mut self, detail: impl AsRef<str>) -> Self {
        self.detail = Some(redact(detail.as_ref()));
        self
    }

    /// Adds a line of context below any existing detail instead of replacing it.
    pub fn add_context(mut self, context: impl AsRef<str>) -> Self {
        let line = redact(context.as_ref());
        self.detail = Some(match self.detail.take() {
            Some(d) if !d.is_empty() => format!("{d}\n{line}"),
            _ => line,
        });
        self
    }

    pub fn with_code(mut self, code: impl Into<String>) -> Self {
        self.code = Some(code.into());
        self
    }

    pub fn with_position(mut self, position: Option<u32>) -> Self {
        self.position = position;
        self
    }

    pub fn invalid_config(msg: impl AsRef<str>) -> Self {
        Self::new(ErrorKind::InvalidConfig, msg)
    }
    pub fn unsupported(msg: impl AsRef<str>) -> Self {
        Self::new(ErrorKind::Unsupported, msg)
    }
    pub fn internal(msg: impl AsRef<str>) -> Self {
        Self::new(ErrorKind::Internal, msg)
    }
    pub fn not_found(msg: impl AsRef<str>) -> Self {
        Self::new(ErrorKind::NotFound, msg)
    }
    pub fn file(msg: impl AsRef<str>) -> Self {
        Self::new(ErrorKind::File, msg)
    }
    pub fn cancelled() -> Self {
        Self::new(ErrorKind::Cancelled, "The query was cancelled")
    }
    pub fn timeout(secs: u64) -> Self {
        Self::new(ErrorKind::Timeout, format!("The operation timed out after {secs}s"))
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::new(ErrorKind::Serialization, "Failed to serialize or parse data").with_detail(e.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::file(format!("File operation failed: {e}"))
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        crate::adapters::sqlite::map_error(e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_are_redacted_on_construction() {
        let e = AppError::new(ErrorKind::Network, "failed: postgres://bob:hunter2@db:5432/app")
            .with_detail("password=hunter2 host=db");
        assert!(!e.message.contains("hunter2"));
        assert!(!e.detail.as_deref().unwrap().contains("hunter2"));
    }

    #[test]
    fn context_is_appended_not_replaced() {
        let e = AppError::new(ErrorKind::Constraint, "fk")
            .with_detail("Key (id)=(3) is referenced")
            .add_context("Statement 1 of 2");
        assert_eq!(e.detail.as_deref(), Some("Key (id)=(3) is referenced\nStatement 1 of 2"));
        let e = AppError::new(ErrorKind::Constraint, "fk").add_context("only");
        assert_eq!(e.detail.as_deref(), Some("only"));
    }

    #[test]
    fn serializes_kind_as_snake_case() {
        let e = AppError::new(ErrorKind::CredentialStore, "x");
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["kind"], "credential_store");
        assert!(v.get("detail").is_none());
    }
}
