//! Local application metadata database (SQLite) with versioned migrations.
//!
//! Holds connection profiles (never passwords), query history, saved queries, filter
//! presets, dashboards, settings and workspace state. Everything stays on this machine.

use std::path::Path;
use std::sync::Mutex;

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::config::ConnectionProfile;
use crate::error::{AppError, Result};

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
];

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
        self.lock()?.execute("DELETE FROM connections WHERE id = ?1", [id])?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Driver, parse_connection_url};

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
