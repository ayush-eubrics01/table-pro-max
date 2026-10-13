//! Optional AI assistance. Off by default; the UI previews the exact prompt
//! (`ai_preview`) and only that prompt is sent (`ai_send`). Prompts and keys are never logged.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;
use tokio_util::sync::CancellationToken;
use tpm_core::ai::{self, AiAnswer, AiConfig, AiPrompt, AiProvider, AiRequest};
use tpm_core::credentials::CredentialStore;
use tpm_core::error::{AppError, ErrorKind, Result};

use crate::state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub config: AiConfig,
    pub key_stored: bool,
    /// False when the key lives only in memory for this run (no OS credential store).
    pub key_persistent: bool,
}

fn config(state: &AppState) -> Result<AiConfig> {
    Ok(AiConfig::from_settings(&state.storage.all_settings()?))
}

async fn load_key(state: &AppState, provider: AiProvider) -> Result<Option<String>> {
    let account = provider.key_account();
    if let Some(k) = state.session_secrets.get(account)? {
        return Ok(Some(k));
    }
    if state.keyring.is_some() {
        return state.keyring_call(move |k| k.get(account)).await;
    }
    Ok(None)
}

#[tauri::command]
pub async fn ai_status(state: State<'_, AppState>) -> Result<AiStatus> {
    let config = config(&state)?;
    let key_stored = load_key(&state, config.provider).await.unwrap_or(None).is_some();
    Ok(AiStatus { config, key_stored, key_persistent: state.keyring.is_some() })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetKeyRequest {
    pub provider: AiProvider,
    /// `None` or empty removes the key.
    pub key: Option<String>,
}

#[tauri::command]
pub async fn ai_set_key(state: State<'_, AppState>, request: SetKeyRequest) -> Result<()> {
    let account = request.provider.key_account();
    let key = request.key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
    state.session_secrets.delete(account)?;
    if state.keyring.is_some() {
        match key {
            Some(k) => state.keyring_call(move |s| s.set(account, &k)).await,
            None => state.keyring_call(move |s| s.delete(account)).await,
        }
    } else {
        match key {
            Some(k) => state.session_secrets.set(account, &k),
            None => Ok(()),
        }
    }
}

#[tauri::command]
pub fn ai_preview(state: State<'_, AppState>, request: AiRequest) -> Result<AiPrompt> {
    let config = config(&state)?;
    if !config.enabled {
        return Err(AppError::new(ErrorKind::PolicyViolation, "AI assistance is turned off in Settings"));
    }
    ai::build_prompt(&config, &request)
}

#[tauri::command]
pub async fn ai_send(state: State<'_, AppState>, prompt: AiPrompt, job_id: String) -> Result<AiAnswer> {
    let config = config(&state)?;
    let key = load_key(&state, config.provider).await?;
    let token = Arc::new(CancellationToken::new());
    state.ai_jobs.lock().unwrap_or_else(|p| p.into_inner()).insert(job_id.clone(), token.clone());
    let result = ai::send(&config, &prompt, key.as_deref(), token).await;
    state.ai_jobs.lock().unwrap_or_else(|p| p.into_inner()).remove(&job_id);
    tracing::info!(provider = ?config.provider, ok = result.is_ok(), "ai request");
    result
}

#[tauri::command]
pub fn ai_cancel(state: State<'_, AppState>, job_id: String) {
    if let Some(t) = state.ai_jobs.lock().unwrap_or_else(|p| p.into_inner()).get(&job_id) {
        t.cancel();
    }
}
