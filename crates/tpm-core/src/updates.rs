//! Update-check rules. The network side lives in the desktop shell (`commands/update.rs`);
//! this module decides whether an automatic check may run and validates what the UI sends.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{AppError, Result};

/// GitHub repository that publishes releases and the update manifest.
pub const REPO: &str = "ayush-eubrics01/table-pro-max";
/// `"ask"` (default), `"on"` or `"off"`.
pub const AUTO_KEY: &str = "updates.auto";
/// Milliseconds since the Unix epoch of the last completed check; 0 means never.
pub const LAST_CHECK_KEY: &str = "updates.lastCheck";
/// Automatic checks run at most this often.
pub const CHECK_INTERVAL_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AutoMode {
    Ask,
    On,
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UpdateSettings {
    pub auto: AutoMode,
    pub last_check_ms: i64,
}

impl UpdateSettings {
    pub fn from_settings(settings: &Map<String, Value>) -> Self {
        let auto = match settings.get(AUTO_KEY).and_then(Value::as_str) {
            Some("on") => AutoMode::On,
            Some("off") => AutoMode::Off,
            _ => AutoMode::Ask,
        };
        let last_check_ms = settings.get(LAST_CHECK_KEY).and_then(Value::as_i64).unwrap_or(0);
        Self { auto, last_check_ms }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoCheck {
    /// The user has not agreed to automatic checks.
    Disabled,
    /// Checked less than a day ago.
    NotDue,
    Due,
}

pub fn auto_check_due(settings: &UpdateSettings, now_ms: i64) -> AutoCheck {
    if settings.auto != AutoMode::On {
        return AutoCheck::Disabled;
    }
    let last = settings.last_check_ms;
    // A last check in the future means the clock moved backwards; check rather than wait.
    if last <= 0 || last > now_ms || now_ms - last >= CHECK_INTERVAL_MS { AutoCheck::Due } else { AutoCheck::NotDue }
}

/// How the running app was installed, which decides how an update is applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallKind {
    Appimage,
    Deb,
    Rpm,
    Nsis,
    Msi,
    App,
    /// Built from source or run outside a bundle: updates can only be downloaded.
    Unknown,
}

impl InstallKind {
    pub fn can_install(self) -> bool {
        self != InstallKind::Unknown
    }
}

/// `MAJOR.MINOR.PATCH` with an optional `-prerelease` made of `[0-9A-Za-z.-]`.
pub fn is_valid_version(v: &str) -> bool {
    if v.len() > 80 {
        return false;
    }
    let (core, pre) = match v.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (v, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    let core_ok = parts.len() == 3
        && parts.iter().all(|p| !p.is_empty() && p.len() <= 9 && p.bytes().all(|b| b.is_ascii_digit()));
    let pre_ok =
        pre.is_none_or(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-'));
    core_ok && pre_ok
}

/// The GitHub page of a release, for "Download" when the app cannot install the update itself.
pub fn release_page_url(version: &str) -> Result<String> {
    if !is_valid_version(version) {
        return Err(AppError::invalid_config("Not a valid version number"));
    }
    Ok(format!("https://github.com/{REPO}/releases/tag/v{version}"))
}

/// One update install at a time. A claim is held from "Update now" until the installer returns,
/// so a second request is refused even while a long install (a password prompt) is running.
#[derive(Debug, Default)]
pub struct InstallLock(std::sync::atomic::AtomicBool);

/// Releases the [`InstallLock`] when dropped.
#[derive(Debug)]
pub struct InstallClaim<'a>(&'a InstallLock);

impl InstallLock {
    pub fn try_claim(&self) -> Option<InstallClaim<'_>> {
        use std::sync::atomic::Ordering::SeqCst;
        self.0.compare_exchange(false, true, SeqCst, SeqCst).ok().map(|_| InstallClaim(self))
    }
}

impl Drop for InstallClaim<'_> {
    fn drop(&mut self) {
        self.0.0.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const DAY: i64 = CHECK_INTERVAL_MS;

    fn s(auto: AutoMode, last: i64) -> UpdateSettings {
        UpdateSettings { auto, last_check_ms: last }
    }

    #[test]
    fn reads_settings_with_safe_defaults() {
        let mut m = Map::new();
        assert_eq!(UpdateSettings::from_settings(&m), s(AutoMode::Ask, 0));
        m.insert(AUTO_KEY.into(), json!("on"));
        m.insert(LAST_CHECK_KEY.into(), json!(5));
        assert_eq!(UpdateSettings::from_settings(&m), s(AutoMode::On, 5));
        m.insert(AUTO_KEY.into(), json!("off"));
        assert_eq!(UpdateSettings::from_settings(&m).auto, AutoMode::Off);
        // Anything unexpected falls back to asking, never to checking.
        m.insert(AUTO_KEY.into(), json!("yes"));
        m.insert(LAST_CHECK_KEY.into(), json!("x"));
        assert_eq!(UpdateSettings::from_settings(&m), s(AutoMode::Ask, 0));
    }

    #[test]
    fn only_on_allows_automatic_checks() {
        let now = 10 * DAY;
        assert_eq!(auto_check_due(&s(AutoMode::Ask, 0), now), AutoCheck::Disabled);
        assert_eq!(auto_check_due(&s(AutoMode::Off, 0), now), AutoCheck::Disabled);
        assert_eq!(auto_check_due(&s(AutoMode::On, 0), now), AutoCheck::Due);
    }

    #[test]
    fn at_most_once_a_day() {
        let now = 10 * DAY;
        assert_eq!(auto_check_due(&s(AutoMode::On, now - DAY + 1), now), AutoCheck::NotDue);
        assert_eq!(auto_check_due(&s(AutoMode::On, now - DAY), now), AutoCheck::Due);
    }

    #[test]
    fn clock_moved_backwards_still_checks() {
        let now = 10 * DAY;
        assert_eq!(auto_check_due(&s(AutoMode::On, now + 1_000), now), AutoCheck::Due);
    }

    #[test]
    fn versions_and_release_page() {
        for ok in ["0.1.0", "10.20.30", "0.2.0-rc.1", "1.0.0-beta-2"] {
            assert!(is_valid_version(ok), "{ok}");
        }
        for bad in [
            "",
            "1.0",
            "1.0.0.0",
            "v1.0.0",
            "1.0.0-",
            "1.0.0-rc/../x",
            "1.a.0",
            "1.0.0 ",
            "1.0.0-<b>",
            "01234567890.0.0",
        ] {
            assert!(!is_valid_version(bad), "{bad}");
        }
        assert_eq!(
            release_page_url("0.2.0").unwrap(),
            "https://github.com/ayush-eubrics01/table-pro-max/releases/tag/v0.2.0"
        );
        assert!(release_page_url("../x").is_err());
    }

    #[test]
    fn install_kinds_and_wire_names() {
        assert!(InstallKind::Deb.can_install());
        assert!(InstallKind::App.can_install());
        assert!(!InstallKind::Unknown.can_install());
        assert_eq!(serde_json::to_value(InstallKind::Appimage).unwrap(), json!("appimage"));
        assert_eq!(serde_json::to_value(AutoMode::On).unwrap(), json!("on"));
    }
}

#[cfg(test)]
mod lock_tests {
    use super::*;

    #[test]
    fn one_install_at_a_time_until_the_claim_is_released() {
        let lock = InstallLock::default();
        let first = lock.try_claim().expect("a free lock can be claimed");
        assert!(lock.try_claim().is_none(), "a second install must be refused while the first runs");
        drop(first);
        assert!(lock.try_claim().is_some(), "the lock is free again once the install ends");
    }
}
