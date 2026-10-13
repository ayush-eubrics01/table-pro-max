//! In-app updates through the official updater plugin. Automatic checks run only when the
//! user agreed (`updates.auto == "on"`) and at most daily; "Check now" always works. Every
//! download is verified against the public key in tauri.conf.json before it is installed.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;
use tokio_util::sync::CancellationToken;
use tpm_core::error::{AppError, ErrorKind, Result};
use tpm_core::updates::{self, AutoCheck, AutoMode, InstallKind, UpdateSettings};

use crate::state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current_version: String,
    pub auto: AutoMode,
    pub last_check: i64,
    pub install_kind: InstallKind,
    pub can_install: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    pub version: String,
    pub date: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub available: Option<AvailableUpdate>,
    /// An automatic check that was not due yet; nothing was sent.
    pub skipped: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    job_id: String,
    downloaded: u64,
    total: Option<u64>,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

fn kind_of(bundle: Option<tauri::utils::config::BundleType>) -> InstallKind {
    use tauri::utils::config::BundleType as B;
    match bundle {
        Some(B::AppImage) => InstallKind::Appimage,
        Some(B::Deb) => InstallKind::Deb,
        Some(B::Rpm) => InstallKind::Rpm,
        Some(B::Nsis) => InstallKind::Nsis,
        Some(B::Msi) => InstallKind::Msi,
        Some(B::App | B::Dmg) => InstallKind::App,
        None => InstallKind::Unknown,
    }
}

fn install_kind() -> InstallKind {
    kind_of(tauri::utils::platform::bundle_type())
}

fn update_error(e: tauri_plugin_updater::Error) -> AppError {
    use tauri_plugin_updater::Error as E;
    let detail = e.to_string();
    let err = match e {
        E::Network(_) | E::Reqwest(_) | E::Http(_) => {
            AppError::new(ErrorKind::Network, "Could not reach the update server").with_code("update_network")
        }
        E::Minisign(_)
        | E::Base64(_)
        | E::SignatureUtf8(_)
        | E::SignedVersionMismatch { .. }
        | E::MissingSignedVersion => {
            AppError::new(ErrorKind::PolicyViolation, "The update could not be verified, so nothing was installed")
                .with_code("update_unverified")
        }
        E::InsecureTransportProtocol | E::EmptyEndpoints | E::UrlParse(_) => {
            AppError::new(ErrorKind::InvalidConfig, "The update server address is not valid")
        }
        E::AuthenticationFailed => AppError::new(
            ErrorKind::Authentication,
            "The update was not installed: the password prompt was cancelled or failed",
        )
        .with_code("update_install_failed"),
        E::DebInstallFailed | E::PackageInstallFailed => {
            AppError::new(ErrorKind::Internal, "The system package manager could not install the update")
                .with_code("update_install_failed")
        }
        _ => AppError::new(ErrorKind::Internal, "The update failed"),
    };
    err.with_detail(detail)
}

fn build_updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater> {
    let mut builder = app.updater_builder();
    // Tests point the app at a local manifest. The signature check still applies.
    if let Ok(endpoint) = std::env::var("TPM_UPDATE_ENDPOINT") {
        let url: tauri::Url =
            endpoint.parse().map_err(|_| AppError::invalid_config("TPM_UPDATE_ENDPOINT is not a valid URL"))?;
        builder = builder.endpoints(vec![url]).map_err(update_error)?;
    }
    builder.build().map_err(update_error)
}

#[tauri::command]
pub fn update_status(app: AppHandle, state: State<'_, AppState>) -> Result<UpdateStatus> {
    let settings = UpdateSettings::from_settings(&state.storage.all_settings()?);
    let kind = install_kind();
    Ok(UpdateStatus {
        current_version: app.package_info().version.to_string(),
        auto: settings.auto,
        last_check: settings.last_check_ms,
        install_kind: kind,
        can_install: kind.can_install(),
    })
}

#[tauri::command]
pub async fn update_check(app: AppHandle, state: State<'_, AppState>, manual: bool) -> Result<UpdateCheck> {
    if !manual {
        let settings = UpdateSettings::from_settings(&state.storage.all_settings()?);
        match updates::auto_check_due(&settings, now_ms()) {
            AutoCheck::Disabled => {
                return Err(AppError::new(ErrorKind::PolicyViolation, "Automatic update checks are off")
                    .with_code("updates_off"));
            }
            AutoCheck::NotDue => return Ok(UpdateCheck { available: None, skipped: true }),
            AutoCheck::Due => {}
        }
    }
    let found = match build_updater(&app)?.check().await {
        Ok(found) => found,
        // The manifest has no file for this platform: nothing to offer.
        Err(tauri_plugin_updater::Error::TargetNotFound(_) | tauri_plugin_updater::Error::TargetsNotFound(_)) => None,
        Err(e) => {
            let err = update_error(e);
            tracing::info!(manual, code = ?err.code, "update check failed");
            return Err(err);
        }
    };
    // Recorded only after a completed check, so an offline start retries next time.
    state.storage.set_setting(updates::LAST_CHECK_KEY, &serde_json::json!(now_ms()))?;
    let available = found.as_ref().map(|u| AvailableUpdate {
        version: u.version.clone(),
        date: u.raw_json.get("pub_date").and_then(|d| d.as_str()).map(str::to_string),
        notes: u.body.clone(),
    });
    tracing::info!(manual, available = available.as_ref().map(|a| a.version.as_str()), "update check");
    *state.pending_update.lock().unwrap_or_else(|p| p.into_inner()) = found;
    Ok(UpdateCheck { available, skipped: false })
}

#[tauri::command]
pub async fn update_install(app: AppHandle, state: State<'_, AppState>, job_id: String) -> Result<()> {
    let update = state
        .pending_update
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .ok_or_else(|| AppError::new(ErrorKind::NotFound, "No update is waiting. Check for updates first."))?;
    let token = Arc::new(CancellationToken::new());
    {
        let mut jobs = state.update_jobs.lock().unwrap_or_else(|p| p.into_inner());
        if !jobs.is_empty() {
            return Err(
                AppError::new(ErrorKind::Conflict, "An update is already being installed").with_code("update_busy")
            );
        }
        jobs.insert(job_id.clone(), token.clone());
    }

    let emitter = app.clone();
    let progress_id = job_id.clone();
    let mut downloaded = 0u64;
    let download = update.download(
        move |chunk, total| {
            downloaded += chunk as u64;
            let _ = emitter.emit("update-progress", Progress { job_id: progress_id.clone(), downloaded, total });
        },
        || {},
    );
    let result = tokio::select! {
        r = download => r.map_err(update_error),
        _ = token.cancelled() => Err(AppError::new(ErrorKind::Cancelled, "Update cancelled")),
    };
    state.update_jobs.lock().unwrap_or_else(|p| p.into_inner()).remove(&job_id);
    let bytes = result.inspect_err(|e| tracing::info!(code = ?e.code, "update download failed"))?;

    // The signature was verified by `download`. Installing may run a system installer, so it
    // happens off the async runtime. On Windows the installer closes the app itself.
    let installer = update.clone();
    tauri::async_runtime::spawn_blocking(move || installer.install(bytes))
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
        .map_err(update_error)
        .inspect_err(|e| tracing::info!(code = ?e.code, "update install failed"))?;
    tracing::info!(version = %update.version, "update installed; restarting");
    state.engine.close_all().await;
    app.restart()
}

#[tauri::command]
pub fn update_cancel(state: State<'_, AppState>, job_id: String) {
    if let Some(t) = state.update_jobs.lock().unwrap_or_else(|p| p.into_inner()).get(&job_id) {
        t.cancel();
    }
}

#[tauri::command]
pub fn update_open_release_page(app: AppHandle, version: String) -> Result<()> {
    let url = updates::release_page_url(&version)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| AppError::new(ErrorKind::Internal, "Could not open the browser").with_detail(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_plugin_updater::Error as E;

    #[test]
    fn maps_plugin_errors_to_clear_app_errors() {
        let e = update_error(E::Network("dns".into()));
        assert_eq!((e.kind, e.code.as_deref()), (ErrorKind::Network, Some("update_network")));

        let e = update_error(E::SignedVersionMismatch { signed: "0.1.1".into(), announced: "0.1.2".into() });
        assert_eq!((e.kind, e.code.as_deref()), (ErrorKind::PolicyViolation, Some("update_unverified")));
        assert!(e.message.contains("nothing was installed"));

        let e = update_error(E::MissingSignedVersion);
        assert_eq!(e.code.as_deref(), Some("update_unverified"));

        let e = update_error(E::AuthenticationFailed);
        assert_eq!((e.kind, e.code.as_deref()), (ErrorKind::Authentication, Some("update_install_failed")));

        let e = update_error(E::PackageInstallFailed);
        assert_eq!(e.code.as_deref(), Some("update_install_failed"));
    }

    #[test]
    fn install_kind_from_bundle_type() {
        use tauri::utils::config::BundleType;
        assert_eq!(kind_of(Some(BundleType::AppImage)), InstallKind::Appimage);
        assert_eq!(kind_of(Some(BundleType::Deb)), InstallKind::Deb);
        assert_eq!(kind_of(Some(BundleType::Rpm)), InstallKind::Rpm);
        assert_eq!(kind_of(Some(BundleType::Nsis)), InstallKind::Nsis);
        assert_eq!(kind_of(Some(BundleType::Msi)), InstallKind::Msi);
        assert_eq!(kind_of(Some(BundleType::Dmg)), InstallKind::App);
        assert_eq!(kind_of(None), InstallKind::Unknown);
    }
}
