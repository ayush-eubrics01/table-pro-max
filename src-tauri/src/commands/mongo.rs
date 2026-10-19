//! MongoDB document browser commands. Read-only, production and confirmation rules are applied
//! in the core (`tpm_core::mongo`).

use serde::{Deserialize, Serialize};
use tauri::State;
use tpm_core::credentials::{CredentialStore, connection_account, ssh_account};
use tpm_core::error::Result;
use tpm_core::mongo::{
    AggregateRequest, DeleteTarget, FindRequest, MongoCollection, MongoDatabase, MongoInfo, MongoPage, ReplaceRequest,
    VectorRequest,
};

use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoConnectRequest {
    pub connection_id: String,
    pub password: Option<String>,
    #[serde(default)]
    pub ssh_secret: Option<String>,
    #[serde(default)]
    pub remember_for_session: bool,
    /// Open production read-only; `None` follows Settings › Safety.
    #[serde(default)]
    pub lock_production: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoConnected {
    pub session_id: String,
    pub info: MongoInfo,
}

#[tauri::command]
pub async fn mongo_connect(state: State<'_, AppState>, request: MongoConnectRequest) -> Result<MongoConnected> {
    let profile = state.storage.get_connection(&request.connection_id)?;
    let ssh_secret = state.resolve_ssh_secret(&profile, request.ssh_secret.clone()).await?;
    let password = state.resolve_password(&profile, request.password.clone()).await?;
    let lock = request.lock_production.unwrap_or_else(|| super::connections::production_read_only(&state));
    let (session_id, info) =
        state.engine.mongo_open(&profile, password.as_deref(), ssh_secret.as_deref(), lock).await?;
    if request.remember_for_session {
        if let Some(pw) = request.password {
            state.session_secrets.set(&connection_account(&profile.id), &pw)?;
        }
        if let Some(s) = request.ssh_secret {
            state.session_secrets.set(&ssh_account(&profile.id), &s)?;
        }
    }
    let _ = state.storage.touch_connection(&profile.id);
    Ok(MongoConnected { session_id, info })
}

#[tauri::command]
pub fn mongo_disconnect(state: State<'_, AppState>, session_id: String) {
    state.engine.mongo_close(&session_id);
}

/// The health check: a `ping`, not a database listing.
#[tauri::command]
pub async fn mongo_ping(state: State<'_, AppState>, session_id: String) -> Result<()> {
    state.engine.mongo(&session_id)?.ping().await
}

#[tauri::command]
pub async fn mongo_databases(state: State<'_, AppState>, session_id: String) -> Result<Vec<MongoDatabase>> {
    state.engine.mongo(&session_id)?.databases().await
}

#[tauri::command]
pub async fn mongo_collections(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
) -> Result<Vec<MongoCollection>> {
    state.engine.mongo(&session_id)?.collections(&database).await
}

#[tauri::command]
pub async fn mongo_find(state: State<'_, AppState>, session_id: String, request: FindRequest) -> Result<MongoPage> {
    state.engine.mongo(&session_id)?.find(&request).await
}

#[tauri::command]
pub async fn mongo_count(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    collection: String,
    filter: String,
) -> Result<u64> {
    state.engine.mongo(&session_id)?.count(&database, &collection, &filter).await
}

#[tauri::command]
pub async fn mongo_aggregate(
    state: State<'_, AppState>,
    session_id: String,
    request: AggregateRequest,
) -> Result<MongoPage> {
    state.engine.mongo(&session_id)?.aggregate(&request).await
}

#[tauri::command]
pub async fn mongo_vector_search(
    state: State<'_, AppState>,
    session_id: String,
    request: VectorRequest,
) -> Result<MongoPage> {
    state.engine.mongo(&session_id)?.vector_search(&request).await
}

/// How many documents a delete would remove: the count its confirmation shows.
#[tauri::command]
pub async fn mongo_delete_count(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    collection: String,
    target: DeleteTarget,
) -> Result<u64> {
    state.engine.mongo(&session_id)?.delete_count(&database, &collection, &target).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoDeleteRequest {
    pub database: String,
    pub collection: String,
    pub target: DeleteTarget,
    /// The count the confirmation showed; a different count now stops the delete.
    pub expected: u64,
    pub confirmed: bool,
    #[serde(default)]
    pub typed_confirmation: Option<String>,
}

#[tauri::command]
pub async fn mongo_delete(state: State<'_, AppState>, session_id: String, request: MongoDeleteRequest) -> Result<u64> {
    let r = state
        .engine
        .mongo(&session_id)?
        .delete(
            &request.database,
            &request.collection,
            &request.target,
            request.expected,
            request.confirmed,
            request.typed_confirmation.as_deref(),
        )
        .await;
    tracing::info!(ok = r.is_ok(), "mongodb delete");
    r
}

/// Saves an edited document if it is still as it was read.
#[tauri::command]
pub async fn mongo_replace(state: State<'_, AppState>, session_id: String, request: ReplaceRequest) -> Result<()> {
    let r = state.engine.mongo(&session_id)?.replace(&request).await;
    tracing::info!(ok = r.is_ok(), "mongodb replace");
    r
}

/// Inserts one document; returns its `_id`.
#[tauri::command]
pub async fn mongo_insert(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    collection: String,
    document: String,
    confirmed: bool,
) -> Result<String> {
    let r = state.engine.mongo(&session_id)?.insert(&database, &collection, &document, confirmed).await;
    tracing::info!(ok = r.is_ok(), "mongodb insert");
    r
}
