//! Local application metadata database (SQLite) with versioned migrations.
//!
//! Holds connection profiles (never passwords), query history, saved queries, filter
//! presets, dashboards, settings, workspace state and restore points (copies of changed rows,
//! unencrypted, kept for a limited time). Everything stays on this machine.

use std::path::Path;
use std::sync::Mutex;

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::config::ConnectionProfile;
use crate::error::{AppError, Result};
use crate::restore::{RestoreKind, RestorePoint, RestorePointSummary, RestoreStatus, RestoreStore};

/// Ordered migrations; index + 1 is the schema version (`PRAGMA user_version`).
const MIGRATIONS: &[&str] = &[
    // v1
    r#"
    CREATE TABLE connections (
        id TEXT PRIMARY KEY,
        profile TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE query_history (
        id INTEGER PRIMARY KEY,
        connection_id TEXT,
        database_name TEXT,
        sql TEXT NOT NULL,
        started_at TEXT NOT NULL,
        duration_ms INTEGER,
        status TEXT NOT NULL,
        row_count INTEGER,
        error TEXT
    );
    CREATE INDEX query_history_started ON query_history(started_at DESC);
    CREATE INDEX query_history_connection ON query_history(connection_id, started_at DESC);
    CREATE TABLE saved_queries (
        id TEXT PRIMARY KEY,
        connection_id TEXT,
        name TEXT NOT NULL,
        folder TEXT,
        sql TEXT NOT NULL,
        favorite INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE filter_presets (
        id TEXT PRIMARY KEY,
        connection_id TEXT,
        schema_name TEXT,
        table_name TEXT,
        name TEXT NOT NULL,
        filter TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE TABLE dashboards (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        definition TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE workspace (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    "#,
    r#"
    CREATE TABLE column_fetch (
        connection_id TEXT NOT NULL,
        schema_name TEXT NOT NULL,
        table_name TEXT NOT NULL,
        column_name TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('load', 'defer')),
        PRIMARY KEY (connection_id, schema_name, table_name, column_name)
    );
    "#,
    // v3: restore points (copies of changed rows, kept locally; see restore.rs)
    r#"
    CREATE TABLE restore_points (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'kept', 'restored')),
        restored_at TEXT,
        kind TEXT NOT NULL,
        schema_name TEXT NOT NULL,
        table_name TEXT NOT NULL,
        statement TEXT NOT NULL,
        data TEXT NOT NULL,
        row_count INTEGER NOT NULL,
        bytes INTEGER NOT NULL
    );
    CREATE INDEX restore_points_conn ON restore_points (connection_id, created_at);
    "#,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FetchMode {
    Load,
    Defer,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnFetch {
    pub column: String,
    pub mode: FetchMode,
}

pub struct Storage {
    conn: Mutex<Connection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredConnection {
    pub profile: ConnectionProfile,
    pub sort_order: i64,
    pub last_used_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: i64,
    pub connection_id: Option<String>,
    pub database_name: Option<String>,
    pub sql: String,
    pub started_at: String,
    pub duration_ms: Option<i64>,
    pub status: String,
    pub row_count: Option<i64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewHistoryEntry {
    pub connection_id: Option<String>,
    pub database_name: Option<String>,
    pub sql: String,
    pub duration_ms: Option<i64>,
    pub status: String,
    pub row_count: Option<i64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuery {
    pub id: String,
    pub connection_id: Option<String>,
    pub name: String,
    pub folder: Option<String>,
    pub sql: String,
    pub favorite: bool,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterPreset {
    pub id: String,
    pub connection_id: Option<String>,
    pub schema_name: Option<String>,
    pub table_name: Option<String>,
    pub name: String,
    pub filter: serde_json::Value,
    #[serde(default)]
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    pub id: String,
    pub name: String,
    pub definition: serde_json::Value,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

impl Storage {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let storage = Self { conn: Mutex::new(conn) };
        storage.migrate()?;
        Ok(storage)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>> {
        self.conn.lock().map_err(|_| AppError::internal("Storage lock poisoned"))
    }

    pub fn schema_version(&self) -> Result<i64> {
        Ok(self.lock()?.query_row("PRAGMA user_version", [], |r| r.get(0))?)
    }

    fn migrate(&self) -> Result<()> {
        let mut conn = self.lock()?;
        let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if current as usize > MIGRATIONS.len() {
            return Err(AppError::internal("The application database was created by a newer version of Table Pro Max"));
        }
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
            let tx = conn.transaction()?;
            tx.execute_batch(sql)?;
            tx.pragma_update(None, "user_version", (i + 1) as i64)?;
            tx.commit()?;
        }
        Ok(())
    }

    // ---- connections -------------------------------------------------------------

    pub fn list_connections(&self) -> Result<Vec<StoredConnection>> {
        let conn = self.lock()?;
        let mut stmt =
            conn.prepare("SELECT profile, sort_order, last_used_at FROM connections ORDER BY sort_order, created_at")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get(1)?, r.get(2)?)))?;
        let mut out = Vec::new();
        for row in rows {
            let (json, sort_order, last_used_at) = row?;
            // A profile that no longer parses (e.g. after a downgrade) is skipped, not fatal.
            match serde_json::from_str::<ConnectionProfile>(&json) {
                Ok(profile) => out.push(StoredConnection { profile, sort_order, last_used_at }),
                Err(e) => tracing::warn!(error = %e, "skipping unreadable connection profile"),
            }
        }
        Ok(out)
    }

    pub fn get_connection(&self, id: &str) -> Result<ConnectionProfile> {
        let json: Option<String> =
            self.lock()?.query_row("SELECT profile FROM connections WHERE id = ?1", [id], |r| r.get(0)).optional()?;
        let json = json.ok_or_else(|| AppError::not_found("Connection not found"))?;
        Ok(serde_json::from_str(&json)?)
    }

    pub fn save_connection(&self, profile: &ConnectionProfile) -> Result<()> {
        profile.validate()?;
        let json = serde_json::to_string(profile)?;
        let ts = now();
        self.lock()?.execute(
            "INSERT INTO connections (id, profile, sort_order, created_at, updated_at)
             VALUES (?1, ?2, (SELECT coalesce(max(sort_order), 0) + 1 FROM connections), ?3, ?3)
             ON CONFLICT(id) DO UPDATE SET profile = excluded.profile, updated_at = excluded.updated_at",
            params![profile.id, json, ts],
        )?;
        Ok(())
    }

    pub fn delete_connection(&self, id: &str) -> Result<()> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM connections WHERE id = ?1", [id])?;
        tx.execute("DELETE FROM column_fetch WHERE connection_id = ?1", [id])?;
        tx.execute("DELETE FROM restore_points WHERE connection_id = ?1", [id])?;
        tx.commit()?;
        Ok(())
    }

    pub fn touch_connection(&self, id: &str) -> Result<()> {
        self.lock()?.execute("UPDATE connections SET last_used_at = ?2 WHERE id = ?1", params![id, now()])?;
        Ok(())
    }

    pub fn reorder_connections(&self, ids: &[String]) -> Result<()> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        for (i, id) in ids.iter().enumerate() {
            tx.execute("UPDATE connections SET sort_order = ?2 WHERE id = ?1", params![id, i as i64])?;
        }
        tx.commit()?;
        Ok(())
    }

    // ---- history -----------------------------------------------------------------

    pub fn add_history(&self, e: &NewHistoryEntry) -> Result<i64> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO query_history (connection_id, database_name, sql, started_at, duration_ms, status, row_count, error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![e.connection_id, e.database_name, e.sql, now(), e.duration_ms, e.status, e.row_count, e.error],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn search_history(&self, connection_id: Option<&str>, search: &str, limit: u32) -> Result<Vec<HistoryEntry>> {
        let conn = self.lock()?;
        let pattern = format!("%{}%", search.replace('!', "!!").replace('%', "!%").replace('_', "!_"));
        let mut stmt = conn.prepare(
            "SELECT id, connection_id, database_name, sql, started_at, duration_ms, status, row_count, error
             FROM query_history
             WHERE (?1 IS NULL OR connection_id = ?1) AND sql LIKE ?2 ESCAPE '!'
             ORDER BY started_at DESC, id DESC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![connection_id, pattern, limit.min(10_000)], |r| {
            Ok(HistoryEntry {
                id: r.get(0)?,
                connection_id: r.get(1)?,
                database_name: r.get(2)?,
                sql: r.get(3)?,
                started_at: r.get(4)?,
                duration_ms: r.get(5)?,
                status: r.get(6)?,
                row_count: r.get(7)?,
                error: r.get(8)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn delete_history(&self, ids: &[i64]) -> Result<()> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        for id in ids {
            tx.execute("DELETE FROM query_history WHERE id = ?1", [id])?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn clear_history(&self, connection_id: Option<&str>) -> Result<()> {
        self.lock()?.execute("DELETE FROM query_history WHERE ?1 IS NULL OR connection_id = ?1", [connection_id])?;
        Ok(())
    }

    /// Deletes history older than `days` and keeps at most `max_entries`.
    pub fn prune_history(&self, days: u32, max_entries: u32) -> Result<usize> {
        let cutoff = (Utc::now() - chrono::Duration::days(days as i64)).to_rfc3339();
        let conn = self.lock()?;
        let mut n = conn.execute("DELETE FROM query_history WHERE started_at < ?1", [cutoff])?;
        n += conn.execute(
            "DELETE FROM query_history WHERE id NOT IN (SELECT id FROM query_history ORDER BY started_at DESC, id DESC LIMIT ?1)",
            [max_entries],
        )?;
        Ok(n)
    }

    // ---- saved queries -----------------------------------------------------------

    pub fn list_saved_queries(&self) -> Result<Vec<SavedQuery>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, connection_id, name, folder, sql, favorite, created_at, updated_at FROM saved_queries
             ORDER BY favorite DESC, coalesce(folder, ''), name COLLATE NOCASE",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(SavedQuery {
                id: r.get(0)?,
                connection_id: r.get(1)?,
                name: r.get(2)?,
                folder: r.get(3)?,
                sql: r.get(4)?,
                favorite: r.get::<_, i64>(5)? != 0,
                created_at: r.get(6)?,
                updated_at: r.get(7)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn save_query(&self, q: &SavedQuery) -> Result<()> {
        if q.name.trim().is_empty() {
            return Err(AppError::invalid_config("A saved query needs a name"));
        }
        let ts = now();
        self.lock()?.execute(
            "INSERT INTO saved_queries (id, connection_id, name, folder, sql, favorite, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
             ON CONFLICT(id) DO UPDATE SET connection_id = excluded.connection_id, name = excluded.name,
               folder = excluded.folder, sql = excluded.sql, favorite = excluded.favorite, updated_at = excluded.updated_at",
            params![q.id, q.connection_id, q.name, q.folder, q.sql, q.favorite as i64, ts],
        )?;
        Ok(())
    }

    pub fn delete_saved_query(&self, id: &str) -> Result<()> {
        self.lock()?.execute("DELETE FROM saved_queries WHERE id = ?1", [id])?;
        Ok(())
    }

    // ---- column fetch overrides (column names only, never values) --------------------

    pub fn list_column_fetch(&self, connection_id: &str, schema: &str, table: &str) -> Result<Vec<ColumnFetch>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT column_name, mode FROM column_fetch WHERE connection_id = ?1 AND schema_name = ?2 AND table_name = ?3 ORDER BY column_name",
        )?;
        let rows = stmt.query_map(params![connection_id, schema, table], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (column, mode) = row?;
            let mode = if mode == "load" { FetchMode::Load } else { FetchMode::Defer };
            out.push(ColumnFetch { column, mode });
        }
        Ok(out)
    }

    pub fn set_column_fetch(
        &self,
        connection_id: &str,
        schema: &str,
        table: &str,
        column: &str,
        mode: Option<FetchMode>,
    ) -> Result<()> {
        let conn = self.lock()?;
        match mode {
            None => {
                conn.execute(
                    "DELETE FROM column_fetch WHERE connection_id = ?1 AND schema_name = ?2 AND table_name = ?3 AND column_name = ?4",
                    params![connection_id, schema, table, column],
                )?;
            }
            Some(m) => {
                let m = if m == FetchMode::Load { "load" } else { "defer" };
                conn.execute(
                    "INSERT INTO column_fetch (connection_id, schema_name, table_name, column_name, mode) VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT DO UPDATE SET mode = excluded.mode",
                    params![connection_id, schema, table, column, m],
                )?;
            }
        }
        Ok(())
    }

    // ---- filter presets ----------------------------------------------------------

    pub fn list_filter_presets(&self, connection_id: &str, schema: &str, table: &str) -> Result<Vec<FilterPreset>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, connection_id, schema_name, table_name, name, filter, created_at FROM filter_presets
             WHERE (connection_id IS NULL OR connection_id = ?1) AND (table_name IS NULL OR (schema_name = ?2 AND table_name = ?3))
             ORDER BY name COLLATE NOCASE",
        )?;
        let rows = stmt.query_map(params![connection_id, schema, table], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, connection_id, schema_name, table_name, name, filter, created_at) = row?;
            out.push(FilterPreset {
                id,
                connection_id,
                schema_name,
                table_name,
                name,
                filter: serde_json::from_str(&filter)?,
                created_at,
            });
        }
        Ok(out)
    }

    pub fn save_filter_preset(&self, p: &FilterPreset) -> Result<()> {
        self.lock()?.execute(
            "INSERT INTO filter_presets (id, connection_id, schema_name, table_name, name, filter, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, filter = excluded.filter",
            params![
                p.id,
                p.connection_id,
                p.schema_name,
                p.table_name,
                p.name,
                serde_json::to_string(&p.filter)?,
                now()
            ],
        )?;
        Ok(())
    }

    pub fn delete_filter_preset(&self, id: &str) -> Result<()> {
        self.lock()?.execute("DELETE FROM filter_presets WHERE id = ?1", [id])?;
        Ok(())
    }

    // ---- dashboards --------------------------------------------------------------

    pub fn list_dashboards(&self) -> Result<Vec<Dashboard>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, name, definition, created_at, updated_at FROM dashboards ORDER BY name COLLATE NOCASE",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get(3)?, r.get(4)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, name, def, created_at, updated_at) = row?;
            out.push(Dashboard { id, name, definition: serde_json::from_str(&def)?, created_at, updated_at });
        }
        Ok(out)
    }

    pub fn save_dashboard(&self, d: &Dashboard) -> Result<()> {
        let ts = now();
        self.lock()?.execute(
            "INSERT INTO dashboards (id, name, definition, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, definition = excluded.definition, updated_at = excluded.updated_at",
            params![d.id, d.name, serde_json::to_string(&d.definition)?, ts],
        )?;
        Ok(())
    }

    pub fn delete_dashboard(&self, id: &str) -> Result<()> {
        self.lock()?.execute("DELETE FROM dashboards WHERE id = ?1", [id])?;
        Ok(())
    }

    // ---- restore points (copies of changed rows; see restore.rs) --------------------

    /// A positive whole-number setting, or `default`.
    fn restore_setting(&self, key: &str, default: i64) -> i64 {
        self.get_setting(key)
            .ok()
            .flatten()
            .and_then(|v| v.as_f64())
            .map(|n| n as i64)
            .filter(|n| *n > 0)
            .unwrap_or(default)
    }

    /// The connection's restore points, newest first (without their row data).
    pub fn list_restore_points(&self, connection_id: &str) -> Result<Vec<RestorePointSummary>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, connection_id, created_at, status, restored_at, kind, schema_name, table_name, statement,
                    row_count, bytes
             FROM restore_points WHERE connection_id = ?1 ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([connection_id], |r| {
            Ok(RestorePointSummary {
                id: r.get(0)?,
                connection_id: r.get(1)?,
                created_at: r.get(2)?,
                status: enum_from_text(r.get(3)?).unwrap_or(RestoreStatus::Kept),
                restored_at: r.get(4)?,
                kind: enum_from_text(r.get(5)?).unwrap_or(RestoreKind::Update),
                schema: r.get(6)?,
                table: r.get(7)?,
                statement: r.get(8)?,
                row_count: r.get::<_, i64>(9)? as u64,
                bytes: r.get::<_, i64>(10)? as u64,
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// Deletes pending restore points: their transaction ended with the app (a crash or a kill),
    /// so the changes they cover were never committed. Run at startup.
    pub fn discard_pending_restore_points(&self) -> Result<usize> {
        Ok(self.lock()?.execute("DELETE FROM restore_points WHERE status = 'pending'", [])?)
    }

    /// Removes restore points older than `restore.keepDays` (default 7), then the oldest until
    /// the total size is within `restore.maxTotalMb` (default 1024). Pending points (their
    /// transaction is still open) are left alone. Returns how many were removed.
    pub fn purge_restore_points(&self) -> Result<usize> {
        let days = self.restore_setting("restore.keepDays", 7);
        let max_bytes = self.restore_setting("restore.maxTotalMb", 1024) * 1024 * 1024;
        let cutoff = (Utc::now() - chrono::Duration::days(days)).to_rfc3339();
        let conn = self.lock()?;
        let mut removed =
            conn.execute("DELETE FROM restore_points WHERE created_at < ?1 AND status <> 'pending'", [cutoff])?;
        loop {
            let total: i64 = conn.query_row("SELECT COALESCE(SUM(bytes), 0) FROM restore_points", [], |r| r.get(0))?;
            if total <= max_bytes {
                break;
            }
            let n = conn.execute(
                "DELETE FROM restore_points WHERE id =
                   (SELECT id FROM restore_points WHERE status <> 'pending' ORDER BY created_at LIMIT 1)",
                [],
            )?;
            if n == 0 {
                break;
            }
            removed += n;
        }
        Ok(removed)
    }

    // ---- settings & workspace ----------------------------------------------------

    pub fn get_setting(&self, key: &str) -> Result<Option<serde_json::Value>> {
        let v: Option<String> =
            self.lock()?.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0)).optional()?;
        v.map(|s| serde_json::from_str(&s).map_err(Into::into)).transpose()
    }

    pub fn all_settings(&self) -> Result<serde_json::Map<String, serde_json::Value>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = serde_json::Map::new();
        for row in rows {
            let (k, v) = row?;
            if let Ok(v) = serde_json::from_str(&v) {
                out.insert(k, v);
            }
        }
        Ok(out)
    }

    pub fn set_setting(&self, key: &str, value: &serde_json::Value) -> Result<()> {
        self.lock()?.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, serde_json::to_string(value)?],
        )?;
        Ok(())
    }

    pub fn reset_settings(&self) -> Result<()> {
        self.lock()?.execute("DELETE FROM settings", [])?;
        Ok(())
    }

    pub fn get_workspace(&self, key: &str) -> Result<Option<serde_json::Value>> {
        let v: Option<String> =
            self.lock()?.query_row("SELECT value FROM workspace WHERE key = ?1", [key], |r| r.get(0)).optional()?;
        v.map(|s| serde_json::from_str(&s).map_err(Into::into)).transpose()
    }

    pub fn set_workspace(&self, key: &str, value: &serde_json::Value) -> Result<()> {
        let json = serde_json::to_string(value)?;
        if json.len() > 16 * 1024 * 1024 {
            return Err(AppError::invalid_config("Workspace state is too large to save"));
        }
        self.lock()?.execute(
            "INSERT INTO workspace (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, json, now()],
        )?;
        Ok(())
    }
}

fn enum_text<T: Serialize>(v: T) -> String {
    serde_json::to_value(v).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
}

fn enum_from_text<T: serde::de::DeserializeOwned>(s: String) -> Option<T> {
    serde_json::from_value(serde_json::Value::String(s)).ok()
}

impl RestoreStore for Storage {
    fn save(&self, p: &RestorePoint) -> Result<()> {
        // A point bigger than the space for all of them would be purged at once: don't keep it.
        let total_mb = self.restore_setting("restore.maxTotalMb", 1024);
        if p.bytes as i64 > total_mb * 1024 * 1024 {
            return Err(AppError::invalid_config(format!(
                "it is larger than the space for all restore points ({total_mb} MB)"
            ))
            .with_code("restore_too_large"));
        }
        self.lock()?.execute(
            "INSERT INTO restore_points (id, connection_id, created_at, status, restored_at, kind, schema_name,
                                         table_name, statement, data, row_count, bytes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                p.id,
                p.connection_id,
                p.created_at,
                enum_text(p.status),
                p.restored_at,
                enum_text(p.kind),
                p.schema,
                p.table,
                p.statement,
                serde_json::to_string(&p.data)?,
                p.row_count as i64,
                p.bytes as i64
            ],
        )?;
        self.purge_restore_points()?;
        Ok(())
    }

    fn get(&self, id: &str) -> Result<RestorePoint> {
        let conn = self.lock()?;
        let row = conn
            .query_row(
                "SELECT id, connection_id, created_at, status, restored_at, kind, schema_name, table_name, statement,
                        data, row_count, bytes
                 FROM restore_points WHERE id = ?1",
                [id],
                |r| {
                    Ok((
                        RestorePoint {
                            id: r.get(0)?,
                            connection_id: r.get(1)?,
                            created_at: r.get(2)?,
                            status: enum_from_text(r.get(3)?).unwrap_or(RestoreStatus::Kept),
                            restored_at: r.get(4)?,
                            kind: enum_from_text(r.get(5)?).unwrap_or(RestoreKind::Update),
                            schema: r.get(6)?,
                            table: r.get(7)?,
                            statement: r.get(8)?,
                            data: Default::default(),
                            row_count: r.get::<_, i64>(10)? as u64,
                            bytes: r.get::<_, i64>(11)? as u64,
                        },
                        r.get::<_, String>(9)?,
                    ))
                },
            )
            .optional()?;
        let (mut point, data) = row.ok_or_else(|| AppError::not_found("This restore point no longer exists"))?;
        point.data = serde_json::from_str(&data)?;
        Ok(point)
    }

    fn set_status(&self, ids: &[String], status: RestoreStatus) -> Result<()> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        let restored_at = (status == RestoreStatus::Restored).then(now);
        for id in ids {
            tx.execute(
                "UPDATE restore_points SET status = ?2, restored_at = COALESCE(?3, restored_at) WHERE id = ?1",
                params![id, enum_text(status), restored_at],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    fn delete(&self, ids: &[String]) -> Result<()> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        for id in ids {
            tx.execute("DELETE FROM restore_points WHERE id = ?1", [id])?;
        }
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Driver, parse_connection_url};

    #[test]
    fn restore_points_are_saved_listed_purged_and_removed_with_the_connection() {
        use crate::restore::{RestoreData, RestoreKind, RestorePoint, RestoreStatus, RestoreStore};
        let s = Storage::open_in_memory().unwrap();
        let p = |id: &str, created: &str, bytes: u64| RestorePoint {
            id: id.into(),
            connection_id: "c1".into(),
            created_at: created.into(),
            status: RestoreStatus::Kept,
            restored_at: None,
            kind: RestoreKind::Update,
            schema: "public".into(),
            table: "orders".into(),
            statement: "UPDATE orders SET a = 1".into(),
            data: RestoreData {
                columns: vec!["id".into()],
                before: vec![vec![Some("1".into())]],
                ..Default::default()
            },
            row_count: 1,
            bytes,
        };
        let now = Utc::now();
        let recent = (now - chrono::Duration::hours(1)).to_rfc3339();
        let old = (now - chrono::Duration::days(8)).to_rfc3339();
        s.save(&p("a", &recent, 10)).unwrap();
        s.save(&p("old", &old, 10)).unwrap(); // older than 7 days: purged on save
        let list = s.list_restore_points("c1").unwrap();
        assert_eq!(list.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), vec!["a"]);
        assert_eq!(s.get("a").unwrap().data.before, vec![vec![Some("1".to_string())]]);
        assert!(s.get("missing").is_err());
        s.set_status(&["a".into()], RestoreStatus::Restored).unwrap();
        let a = s.get("a").unwrap();
        assert_eq!(a.status, RestoreStatus::Restored);
        assert!(a.restored_at.is_some());
        // A pending point is never purged by age (its transaction is still open).
        let mut pending = p("pend", &old, 10);
        pending.status = RestoreStatus::Pending;
        s.save(&pending).unwrap();
        assert!(s.get("pend").is_ok());
        s.delete(&["pend".into()]).unwrap();
        assert!(s.get("pend").is_err());
        // Total size cap: the oldest go first.
        s.set_setting("restore.maxTotalMb", &serde_json::json!(1)).unwrap();
        s.save(&p("big1", &(now - chrono::Duration::minutes(30)).to_rfc3339(), 700_000)).unwrap();
        s.save(&p("big2", &now.to_rfc3339(), 700_000)).unwrap();
        let ids: Vec<String> = s.list_restore_points("c1").unwrap().into_iter().map(|x| x.id).collect();
        assert_eq!(ids, vec!["big2".to_string()]);
        // A shorter keep period applies at the next purge.
        s.set_setting("restore.keepDays", &serde_json::json!(1)).unwrap();
        s.save(&p("two_days", &(now - chrono::Duration::days(2)).to_rfc3339(), 1)).unwrap();
        assert!(s.get("two_days").is_err());
        s.delete_connection("c1").unwrap();
        assert!(s.list_restore_points("c1").unwrap().is_empty());
    }

    #[test]
    fn a_restore_point_larger_than_all_the_space_is_not_kept() {
        use crate::restore::{RestoreData, RestoreKind, RestorePoint, RestoreStatus, RestoreStore};
        let s = Storage::open_in_memory().unwrap();
        s.set_setting("restore.maxTotalMb", &serde_json::json!(1)).unwrap();
        let p = |id: &str, bytes: u64| RestorePoint {
            id: id.into(),
            connection_id: "c1".into(),
            created_at: Utc::now().to_rfc3339(),
            status: RestoreStatus::Kept,
            restored_at: None,
            kind: RestoreKind::Update,
            schema: "public".into(),
            table: "t".into(),
            statement: "UPDATE t SET a = 1".into(),
            data: RestoreData::default(),
            row_count: 1,
            bytes,
        };
        s.save(&p("small", 10)).unwrap();
        let err = s.save(&p("huge", 2 * 1024 * 1024)).unwrap_err();
        assert_eq!(err.code.as_deref(), Some("restore_too_large"));
        assert!(err.message.contains("1 MB"), "{}", err.message);
        assert!(s.get("huge").is_err());
        assert!(s.get("small").is_ok(), "the others stay");
    }

    #[test]
    fn pending_restore_points_left_by_a_crash_are_discarded() {
        use crate::restore::{RestoreData, RestoreKind, RestorePoint, RestoreStatus, RestoreStore};
        let s = Storage::open_in_memory().unwrap();
        let p = |id: &str, status| RestorePoint {
            id: id.into(),
            connection_id: "c1".into(),
            created_at: Utc::now().to_rfc3339(),
            status,
            restored_at: None,
            kind: RestoreKind::Update,
            schema: "public".into(),
            table: "t".into(),
            statement: "UPDATE t SET a = 1".into(),
            data: RestoreData::default(),
            row_count: 1,
            bytes: 1,
        };
        s.save(&p("kept", RestoreStatus::Kept)).unwrap();
        s.save(&p("pending", RestoreStatus::Pending)).unwrap();
        assert_eq!(s.discard_pending_restore_points().unwrap(), 1);
        assert!(s.get("pending").is_err());
        assert!(s.get("kept").is_ok());
    }

    #[test]
    fn column_fetch_overrides_are_per_table_and_removed_with_the_connection() {
        let s = Storage::open_in_memory().unwrap();
        s.set_column_fetch("c1", "public", "docs", "body", Some(FetchMode::Load)).unwrap();
        s.set_column_fetch("c1", "public", "docs", "title", Some(FetchMode::Defer)).unwrap();
        s.set_column_fetch("c1", "public", "docs", "body", Some(FetchMode::Defer)).unwrap(); // replaces
        s.set_column_fetch("c1", "public", "other", "body", Some(FetchMode::Load)).unwrap();
        let got = s.list_column_fetch("c1", "public", "docs").unwrap();
        assert_eq!(got.len(), 2);
        assert!(got.iter().any(|f| f.column == "body" && f.mode == FetchMode::Defer));
        s.set_column_fetch("c1", "public", "docs", "title", None).unwrap();
        assert_eq!(s.list_column_fetch("c1", "public", "docs").unwrap().len(), 1);
        s.delete_connection("c1").unwrap();
        assert!(s.list_column_fetch("c1", "public", "other").unwrap().is_empty());
    }

    #[test]
    fn migrates_and_reopens() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("app.db");
        {
            let s = Storage::open(&path).unwrap();
            assert_eq!(s.schema_version().unwrap(), MIGRATIONS.len() as i64);
            s.save_connection(&ConnectionProfile::new("a", Driver::Postgres)).unwrap();
        }
        let s = Storage::open(&path).unwrap();
        assert_eq!(s.list_connections().unwrap().len(), 1);
    }

    #[test]
    fn refuses_newer_schema() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.db");
        Connection::open(&path).unwrap().pragma_update(None, "user_version", 999).unwrap();
        assert!(Storage::open(&path).is_err());
    }

    #[test]
    fn connections_crud_without_passwords() {
        let s = Storage::open_in_memory().unwrap();
        let parsed = parse_connection_url("postgres://me:supersecret@db/app").unwrap();
        s.save_connection(&parsed.profile).unwrap();
        let conn = s.lock().unwrap();
        let raw: String = conn.query_row("SELECT profile FROM connections", [], |r| r.get(0)).unwrap();
        assert!(!raw.contains("supersecret"));
        drop(conn);

        let mut p = s.get_connection(&parsed.profile.id).unwrap();
        p.name = "renamed".into();
        s.save_connection(&p).unwrap();
        let second = ConnectionProfile::new("b", Driver::Mysql);
        s.save_connection(&second).unwrap();
        let list = s.list_connections().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].profile.name, "renamed");
        s.reorder_connections(&[second.id.clone(), p.id.clone()]).unwrap();
        assert_eq!(s.list_connections().unwrap()[0].profile.id, second.id);
        s.delete_connection(&p.id).unwrap();
        assert!(s.get_connection(&p.id).is_err());
    }

    #[test]
    fn history_search_and_retention() {
        let s = Storage::open_in_memory().unwrap();
        for i in 0..5 {
            s.add_history(&NewHistoryEntry {
                connection_id: Some("c1".into()),
                database_name: None,
                sql: format!("select {i} as pct_100%"),
                duration_ms: Some(3),
                status: "success".into(),
                row_count: Some(1),
                error: None,
            })
            .unwrap();
        }
        assert_eq!(s.search_history(Some("c1"), "select", 100).unwrap().len(), 5);
        assert_eq!(s.search_history(Some("c1"), "3 as", 100).unwrap().len(), 1);
        assert_eq!(s.search_history(Some("c1"), "100%", 100).unwrap().len(), 5);
        assert_eq!(s.search_history(Some("c2"), "", 100).unwrap().len(), 0);
        assert_eq!(s.prune_history(30, 2).unwrap(), 3);
        assert_eq!(s.search_history(None, "", 100).unwrap().len(), 2);
        s.clear_history(Some("c1")).unwrap();
        assert!(s.search_history(None, "", 100).unwrap().is_empty());
    }

    #[test]
    fn saved_queries_settings_workspace_dashboards() {
        let s = Storage::open_in_memory().unwrap();
        let q = SavedQuery {
            id: "q1".into(),
            connection_id: None,
            name: "Active users".into(),
            folder: Some("reports".into()),
            sql: "select 1".into(),
            favorite: true,
            created_at: String::new(),
            updated_at: String::new(),
        };
        s.save_query(&q).unwrap();
        assert_eq!(s.list_saved_queries().unwrap()[0].name, "Active users");
        s.delete_saved_query("q1").unwrap();
        assert!(s.list_saved_queries().unwrap().is_empty());

        s.set_setting("theme", &serde_json::json!("dark")).unwrap();
        assert_eq!(s.get_setting("theme").unwrap(), Some(serde_json::json!("dark")));
        assert_eq!(s.all_settings().unwrap().len(), 1);
        s.reset_settings().unwrap();
        assert_eq!(s.get_setting("theme").unwrap(), None);

        s.set_workspace("tabs", &serde_json::json!({"open": [1, 2]})).unwrap();
        assert_eq!(s.get_workspace("tabs").unwrap().unwrap()["open"][1], 2);

        let d = Dashboard {
            id: "d1".into(),
            name: "Ops".into(),
            definition: serde_json::json!({"widgets": []}),
            created_at: String::new(),
            updated_at: String::new(),
        };
        s.save_dashboard(&d).unwrap();
        assert_eq!(s.list_dashboards().unwrap()[0].definition["widgets"], serde_json::json!([]));

        let p = FilterPreset {
            id: "f1".into(),
            connection_id: Some("c".into()),
            schema_name: Some("public".into()),
            table_name: Some("users".into()),
            name: "recent".into(),
            filter: serde_json::json!({"type": "group"}),
            created_at: String::new(),
        };
        s.save_filter_preset(&p).unwrap();
        assert_eq!(s.list_filter_presets("c", "public", "users").unwrap().len(), 1);
        assert_eq!(s.list_filter_presets("c", "public", "orders").unwrap().len(), 0);
    }
}
