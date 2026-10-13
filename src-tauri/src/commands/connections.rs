//! Connection profile management and session lifecycle.

use serde::{Deserialize, Serialize};
use tauri::State;
use tpm_core::adapters::ConnectOptions;
use tpm_core::config::{ConnectionProfile, PasswordMode, ProfileBundle, parse_connection_url};
use tpm_core::credentials::{CredentialStore, connection_account, ssh_account};
use tpm_core::engine::SessionInfo;
use tpm_core::error::{AppError, Result};
use tpm_core::storage::StoredConnection;

use crate::state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub data_dir: String,
    pub log_dir: String,
    pub credential_store: String,
    pub credential_store_available: bool,
    pub platform: String,
}

#[tauri::command]
pub fn app_info(state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        data_dir: state.data_dir.to_string_lossy().into_owned(),
        log_dir: state.log_dir.to_string_lossy().into_owned(),
        credential_store: state.credential_store_name().to_string(),
        credential_store_available: state.keyring.is_some(),
        platform: std::env::consts::OS.to_string(),
    }
}

#[tauri::command]
pub fn list_connections(state: State<'_, AppState>) -> Result<Vec<StoredConnection>> {
    state.storage.list_connections()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedUrlResponse {
    pub profile: ConnectionProfile,
    /// Returned so the form can prefill the password field the user just pasted.
    pub password: Option<String>,
}

#[tauri::command]
pub fn parse_url(url: String) -> Result<ParsedUrlResponse> {
    let parsed = parse_connection_url(&url)?;
    Ok(ParsedUrlResponse { profile: parsed.profile, password: parsed.password })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveConnectionRequest {
    pub profile: ConnectionProfile,
    /// New password. `None` keeps the stored one unchanged.
    pub password: Option<String>,
    /// New SSH password or key passphrase. `None` keeps the stored one unchanged.
    #[serde(default)]
    pub ssh_secret: Option<String>,
}

/// Stores or clears one secret according to its mode.
async fn store_secret(state: &AppState, account: String, mode: PasswordMode, secret: Option<String>) -> Result<()> {
    match (mode, secret) {
        (PasswordMode::Keychain, Some(pw)) => {
            let acct = account.clone();
            state.keyring_call(move |k| k.set(&acct, &pw)).await?;
        }
        (PasswordMode::Keychain, None) => {}
        (PasswordMode::Ask | PasswordMode::None, pw) => {
            // Never persist a secret the user chose not to store; drop any old one.
            if state.keyring.is_some() {
                let acct = account.clone();
                let _ = state.keyring_call(move |k| k.delete(&acct)).await;
            }
            match pw {
                Some(p) if mode == PasswordMode::Ask => state.session_secrets.set(&account, &p)?,
                _ => state.session_secrets.delete(&account)?,
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn save_connection(state: State<'_, AppState>, request: SaveConnectionRequest) -> Result<ConnectionProfile> {
    let SaveConnectionRequest { profile, password, ssh_secret } = request;
    profile.validate()?;
    store_secret(&state, connection_account(&profile.id), profile.password_mode, password).await?;
    match &profile.ssh {
        Some(ssh) => store_secret(&state, ssh_account(&profile.id), ssh.secret_mode, ssh_secret).await?,
        None => store_secret(&state, ssh_account(&profile.id), PasswordMode::None, None).await?,
    }
    state.storage.save_connection(&profile)?;
    tracing::info!(connection = %profile.id, driver = ?profile.driver, "saved connection profile");
    Ok(profile)
}

#[tauri::command]
pub async fn delete_connection(state: State<'_, AppState>, id: String) -> Result<()> {
    for sid in state.engine.sessions_for_connection(&id) {
        state.engine.close_session(&sid).await;
    }
    for account in [connection_account(&id), ssh_account(&id)] {
        state.session_secrets.delete(&account)?;
        if state.keyring.is_some() {
            let _ = state.keyring_call(move |k| k.delete(&account)).await;
        }
    }
    state.storage.delete_connection(&id)
}

#[tauri::command]
pub async fn duplicate_connection(state: State<'_, AppState>, id: String) -> Result<ConnectionProfile> {
    let mut profile = state.storage.get_connection(&id)?;
    let old_id = profile.id.clone();
    profile.id = uuid::Uuid::new_v4().to_string();
    profile.name = format!("{} copy", profile.name);
    let pairs = [
        (connection_account(&old_id), connection_account(&profile.id), profile.password_mode),
        (
            ssh_account(&old_id),
            ssh_account(&profile.id),
            profile.ssh.as_ref().map_or(PasswordMode::None, |s| s.secret_mode),
        ),
    ];
    for (old, new, mode) in pairs {
        if mode == PasswordMode::Keychain && state.keyring.is_some() {
            let (o, n) = (old.clone(), new.clone());
            state
                .keyring_call(move |k| {
                    if let Some(pw) = k.get(&o)? {
                        k.set(&n, &pw)?;
                    }
                    Ok(())
                })
                .await?;
        }
        if let Some(pw) = state.session_secrets.get(&old)? {
            state.session_secrets.set(&new, &pw)?;
        }
    }
    state.storage.save_connection(&profile)?;
    Ok(profile)
}

#[tauri::command]
pub fn reorder_connections(state: State<'_, AppState>, ids: Vec<String>) -> Result<()> {
    state.storage.reorder_connections(&ids)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionRequest {
    pub profile: ConnectionProfile,
    pub password: Option<String>,
    #[serde(default)]
    pub ssh_secret: Option<String>,
}

/// Connects with an unsaved profile and disconnects immediately.
#[tauri::command]
pub async fn test_connection(
    state: State<'_, AppState>,
    request: TestConnectionRequest,
) -> Result<tpm_core::model::ServerInfo> {
    let password = match request.password {
        Some(p) => Some(p),
        None => match state.resolve_password(&request.profile, None).await {
            Ok(p) => p,
            // An unsaved profile may legitimately have no stored password (e.g. trust auth).
            Err(e) if e.code.as_deref() == Some("password_required") => None,
            Err(e) => return Err(e),
        },
    };
    let ssh_secret = match request.ssh_secret {
        Some(s) => Some(s),
        None => match state.resolve_ssh_secret(&request.profile, None).await {
            Ok(s) => s,
            Err(e) if e.code.as_deref() == Some("ssh_secret_required") => None,
            Err(e) => return Err(e),
        },
    };
    if request.profile.driver == tpm_core::config::Driver::Redis {
        let (id, info) = state.engine.redis_open(&request.profile, password.as_deref(), ssh_secret.as_deref()).await?;
        state.engine.redis_close(&id);
        return Ok(tpm_core::model::ServerInfo {
            product: "Redis".into(),
            version: info.version,
            current_database: info.db.to_string(),
            current_user: request.profile.user.clone(),
        });
    }
    let info = state
        .engine
        .open_session(&request.profile, password.as_deref(), ssh_secret.as_deref(), ConnectOptions::default())
        .await?;
    state.engine.close_session(&info.session_id).await;
    Ok(info.server)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    pub connection_id: String,
    pub password: Option<String>,
    #[serde(default)]
    pub ssh_secret: Option<String>,
    pub database: Option<String>,
    /// Remember an "ask every time" password for the rest of this app run.
    #[serde(default)]
    pub remember_for_session: bool,
    /// Open the session read-only regardless of the profile (dashboards).
    #[serde(default)]
    pub read_only: bool,
}

#[tauri::command]
pub async fn connect(state: State<'_, AppState>, request: ConnectRequest) -> Result<SessionInfo> {
    let mut profile = state.storage.get_connection(&request.connection_id)?;
    if request.read_only {
        profile.safety_mode = tpm_core::config::SafetyMode::ReadOnly;
    }
    let explicit = request.password.clone();
    let explicit_ssh = request.ssh_secret.clone();
    // The tunnel comes first, so ask for its secret before the database password.
    let ssh_secret = state.resolve_ssh_secret(&profile, explicit_ssh.clone()).await?;
    let password = state.resolve_password(&profile, explicit.clone()).await?;
    let info = state
        .engine
        .open_session(
            &profile,
            password.as_deref(),
            ssh_secret.as_deref(),
            ConnectOptions { database: request.database.filter(|d| !d.is_empty()), tunnel_port: None },
        )
        .await?;
    if request.remember_for_session {
        if let Some(pw) = explicit {
            state.session_secrets.set(&connection_account(&profile.id), &pw)?;
        }
        if let Some(s) = explicit_ssh {
            state.session_secrets.set(&ssh_account(&profile.id), &s)?;
        }
    }
    let _ = state.storage.touch_connection(&profile.id);
    tracing::info!(connection = %profile.id, session = %info.session_id, "connected");
    Ok(info)
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, session_id: String) -> Result<()> {
    state.engine.close_session(&session_id).await;
    Ok(())
}

#[tauri::command]
pub async fn reconnect(
    state: State<'_, AppState>,
    session_id: String,
    password: Option<String>,
    ssh_secret: Option<String>,
) -> Result<SessionInfo> {
    let info = state.engine.session_info(&session_id)?;
    let profile = state.storage.get_connection(&info.connection_id)?;
    let ssh_secret = state.resolve_ssh_secret(&profile, ssh_secret).await?;
    let password = state.resolve_password(&profile, password).await?;
    state.engine.reconnect(&session_id, password.as_deref(), ssh_secret.as_deref()).await
}

/// Trusts an SSH host key after the user compared its fingerprint.
#[tauri::command]
pub fn trust_ssh_host(state: State<'_, AppState>, host: String, port: u16, key: String) -> Result<()> {
    state.engine.trust_ssh_host(&host, port, &key)?;
    tracing::info!(%host, port, "trusted SSH host key");
    Ok(())
}

#[tauri::command]
pub async fn ping(state: State<'_, AppState>, session_id: String) -> Result<()> {
    state.engine.ping(&session_id).await
}

/// Creates a new, empty database file for a file-based driver. Never overwrites.
#[tauri::command]
pub async fn create_database_file(driver: tpm_core::config::Driver, path: String) -> Result<()> {
    let p = std::path::Path::new(&path);
    if !p.is_absolute() {
        return Err(AppError::file("Choose an absolute path for the new database"));
    }
    tokio::task::spawn_blocking(move || match driver {
        tpm_core::config::Driver::Sqlite => tpm_core::adapters::sqlite::create_database_file(&path),
        #[cfg(feature = "duckdb")]
        tpm_core::config::Driver::Duckdb => tpm_core::adapters::duckdb::create_database_file(&path),
        _ => Err(AppError::unsupported("This database type is not file based")),
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))?
}

/// Writes profiles (never secrets) to a JSON file chosen through the save dialog.
#[tauri::command]
pub async fn export_connections(state: State<'_, AppState>, path: String, ids: Option<Vec<String>>) -> Result<usize> {
    let p = std::path::PathBuf::from(&path);
    if !p.is_absolute() || p.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("json")) != Some(true)
    {
        return Err(AppError::file("Choose an absolute path ending in .json"));
    }
    let profiles: Vec<ConnectionProfile> = state
        .storage
        .list_connections()?
        .into_iter()
        .map(|c| c.profile)
        .filter(|p| ids.as_ref().is_none_or(|ids| ids.contains(&p.id)))
        .collect();
    let n = profiles.len();
    let json = serde_json::to_string_pretty(&ProfileBundle::new(profiles))?;
    tokio::task::spawn_blocking(move || std::fs::write(p, json).map_err(AppError::from))
        .await
        .map_err(|e| AppError::internal(e.to_string()))??;
    Ok(n)
}

/// Imports profiles from an export file. They get new ids and ask for passwords.
#[tauri::command]
pub async fn import_connections(state: State<'_, AppState>, path: String) -> Result<usize> {
    let meta = std::fs::metadata(&path).map_err(|e| AppError::file(format!("Cannot read {path}: {e}")))?;
    if meta.len() > 16 * 1024 * 1024 {
        return Err(AppError::file("The file is too large to be a connection export"));
    }
    let json = tokio::task::spawn_blocking(move || std::fs::read_to_string(path))
        .await
        .map_err(|e| AppError::internal(e.to_string()))??;
    let profiles = ProfileBundle::parse_for_import(&json)?;
    for p in &profiles {
        state.storage.save_connection(p)?;
    }
    Ok(profiles.len())
}

/// Opens another application window. Windows share connections' backend but keep their
/// own tabs and state.
#[tauri::command]
pub async fn open_window(app: tauri::AppHandle) -> Result<()> {
    let label = format!("window-{}", uuid::Uuid::new_v4().simple());
    let builder = tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::App("index.html".into()))
        .title("Table Pro Max")
        .inner_size(1280.0, 820.0)
        .min_inner_size(900.0, 560.0);
    // Same chrome as the main window (tauri.<os>.conf.json): native traffic lights on macOS,
    // the app's own title bar elsewhere.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(14.0, 14.0));
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false);
    builder.build().map_err(|e| AppError::internal(format!("Could not open a window: {e}")))?;
    Ok(())
}
