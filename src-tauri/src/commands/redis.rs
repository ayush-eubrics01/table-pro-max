//! Redis key browser and console commands.

use serde::{Deserialize, Serialize};
use tauri::State;
use tpm_core::credentials::{CredentialStore, connection_account, ssh_account};
use tpm_core::error::Result;
use tpm_core::redis_kv::{RedisInfo, RedisValue, ScanPage, parse_command_line};

use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisConnectRequest {
    pub connection_id: String,
    pub password: Option<String>,
    #[serde(default)]
    pub ssh_secret: Option<String>,
    #[serde(default)]
    pub remember_for_session: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisConnected {
    pub session_id: String,
    pub info: RedisInfo,
}

#[tauri::command]
pub async fn redis_connect(state: State<'_, AppState>, request: RedisConnectRequest) -> Result<RedisConnected> {
    let profile = state.storage.get_connection(&request.connection_id)?;
    let ssh_secret = state.resolve_ssh_secret(&profile, request.ssh_secret.clone()).await?;
    let password = state.resolve_password(&profile, request.password.clone()).await?;
    let (session_id, info) = state.engine.redis_open(&profile, password.as_deref(), ssh_secret.as_deref()).await?;
    if request.remember_for_session {
        if let Some(pw) = request.password {
            state.session_secrets.set(&connection_account(&profile.id), &pw)?;
        }
        if let Some(s) = request.ssh_secret {
            state.session_secrets.set(&ssh_account(&profile.id), &s)?;
        }
    }
    let _ = state.storage.touch_connection(&profile.id);
    Ok(RedisConnected { session_id, info })
}

#[tauri::command]
pub fn redis_disconnect(state: State<'_, AppState>, session_id: String) {
    state.engine.redis_close(&session_id);
}

#[tauri::command]
pub async fn redis_info(state: State<'_, AppState>, session_id: String) -> Result<RedisInfo> {
    state.engine.redis(&session_id)?.lock().await.info().await
}

#[tauri::command]
pub async fn redis_scan(
    state: State<'_, AppState>,
    session_id: String,
    cursor: String,
    pattern: String,
    count: usize,
) -> Result<ScanPage> {
    state.engine.redis(&session_id)?.lock().await.scan(&cursor, &pattern, count).await
}

#[tauri::command]
pub async fn redis_read(state: State<'_, AppState>, session_id: String, key: String) -> Result<RedisValue> {
    state.engine.redis(&session_id)?.lock().await.read(&key).await
}

#[tauri::command]
pub async fn redis_set_string(
    state: State<'_, AppState>,
    session_id: String,
    key: String,
    value: String,
    keep_ttl: bool,
) -> Result<()> {
    state.engine.redis(&session_id)?.lock().await.set_string(&key, &value, keep_ttl).await
}

#[tauri::command]
pub async fn redis_hash_set(
    state: State<'_, AppState>,
    session_id: String,
    key: String,
    field: String,
    value: String,
) -> Result<()> {
    state.engine.redis(&session_id)?.lock().await.hash_set(&key, &field, &value).await
}

#[tauri::command]
pub async fn redis_hash_delete(
    state: State<'_, AppState>,
    session_id: String,
    key: String,
    field: String,
) -> Result<()> {
    state.engine.redis(&session_id)?.lock().await.hash_delete(&key, &field).await
}

#[tauri::command]
pub async fn redis_delete(state: State<'_, AppState>, session_id: String, key: String) -> Result<bool> {
    state.engine.redis(&session_id)?.lock().await.delete(&key).await
}

#[tauri::command]
pub async fn redis_expire(
    state: State<'_, AppState>,
    session_id: String,
    key: String,
    seconds: Option<i64>,
) -> Result<()> {
    state.engine.redis(&session_id)?.lock().await.expire(&key, seconds).await
}

/// Runs one console line. Read-only and confirmation rules are applied in the core.
#[tauri::command]
pub async fn redis_command(
    state: State<'_, AppState>,
    session_id: String,
    line: String,
    confirmed: bool,
) -> Result<String> {
    let argv = parse_command_line(&line)?;
    let result = state.engine.redis(&session_id)?.lock().await.command(&argv, confirmed, 30).await;
    tracing::info!(command = %argv.first().map(|s| s.to_ascii_uppercase()).unwrap_or_default(), ok = result.is_ok(), "redis console");
    result
}
