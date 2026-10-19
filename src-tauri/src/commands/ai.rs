//! Optional AI assistance. Off by default; the UI previews the exact prompt
//! (`ai_preview`) and only that prompt is sent (`ai_send`). Prompts and keys are never logged.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

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
    // The job can be cancelled from now on, also while the key is read.
    let token = job_token(&state.ai_jobs, &job_id);
    let result = async {
        let config = config(&state)?;
        let key = load_key(&state, config.provider).await?;
        let r = ai::send(&config, &prompt, key.as_deref(), token).await;
        tracing::info!(provider = ?config.provider, ok = r.is_ok(), "ai request");
        r
    }
    .await;
    finish_job(&state.ai_jobs, &job_id);
    result
}

type Jobs = Mutex<HashMap<String, Arc<CancellationToken>>>;

/// A request's cancel token, made by whichever comes first: the request, or a Cancel clicked
/// before it got going (which then stops it).
fn job_token(jobs: &Jobs, job_id: &str) -> Arc<CancellationToken> {
    jobs.lock().unwrap_or_else(|p| p.into_inner()).entry(job_id.to_string()).or_default().clone()
}

fn cancel_job(jobs: &Jobs, job_id: &str) {
    job_token(jobs, job_id).cancel();
}

fn finish_job(jobs: &Jobs, job_id: &str) {
    jobs.lock().unwrap_or_else(|p| p.into_inner()).remove(job_id);
}

#[tauri::command]
pub fn ai_cancel(state: State<'_, AppState>, job_id: String) {
    cancel_job(&state.ai_jobs, &job_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cancel_before_the_request_starts_still_stops_it() {
        let jobs = Mutex::new(HashMap::new());
        // Cancel clicked while the key is being read: the job isn't running yet.
        cancel_job(&jobs, "j1");
        let token = job_token(&jobs, "j1");
        assert!(token.is_cancelled(), "the send sees the earlier cancel");
        finish_job(&jobs, "j1");
        assert!(jobs.lock().unwrap().is_empty());
        // The usual order: started, then cancelled.
        let token = job_token(&jobs, "j2");
        cancel_job(&jobs, "j2");
        assert!(token.is_cancelled());
    }
}
