//! Core library for Table Pro Max: database adapters, query building, safety analysis,
//! local storage and credential handling. It has no UI or Tauri dependency so it can be
//! built and tested on any platform without a webview toolchain.

pub mod adapters;
pub mod ai;
pub mod browse;
pub mod changes;
pub mod config;
pub mod credentials;
pub mod ddl;
pub mod dialect;
pub mod engine;
pub mod error;
pub mod filter;
pub mod model;
pub mod redact;
pub mod redis_kv;
pub mod result_edit;
pub mod safety;
pub mod split;
pub mod ssh;
pub mod storage;
pub mod transfer;
pub mod updates;

pub use error::{AppError, ErrorKind, Result};
