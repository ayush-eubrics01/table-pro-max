//! Data types exchanged between adapters, the engine and the UI.

use serde::{Deserialize, Serialize, Serializer};

/// A single result cell. Values are carried as text (the server's own text
/// representation) so no precision is lost crossing into JavaScript.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cell {
    Null,
    Text(String),
    Bytes(Vec<u8>),
    /// A deferred column in an opened table: not read from the database (see large_values.rs).
    NotLoaded,
    /// Long text in a query result, sent to the UI as a preview; the full value stays in the
    /// result store.
    Partial {
        preview: String,
        length: u64,
    },
}

/// Binary values larger than this are previewed, not transferred in full.
pub const BYTES_PREVIEW_LIMIT: usize = 4096;

impl Serialize for Cell {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        match self {
            Cell::Null => s.serialize_none(),
            Cell::Text(t) => s.serialize_str(t),
            Cell::Bytes(b) => {
                let shown = &b[..b.len().min(BYTES_PREVIEW_LIMIT)];
                let mut m = s.serialize_map(Some(2))?;
                m.serialize_entry("$bytes", &hex::encode(shown))?;
                m.serialize_entry("size", &b.len())?;
                m.end()
            }
            Cell::NotLoaded => {
                let mut m = s.serialize_map(Some(1))?;
                m.serialize_entry("$notLoaded", &true)?;
                m.end()
            }
            Cell::Partial { preview, length } => {
                let mut m = s.serialize_map(Some(2))?;
                m.serialize_entry("$partial", preview)?;
                m.serialize_entry("length", length)?;
                m.end()
            }
        }
    }
}

impl Cell {
    pub fn as_text(&self) -> Option<&str> {
        match self {
            Cell::Text(t) => Some(t),
            _ => None,
        }
    }

    /// Text used for exports: NULL becomes `None`, bytes become `\x` hex.
    pub fn to_export_string(&self) -> Option<String> {
        match self {
            Cell::Null => None,
            Cell::Text(t) => Some(t.clone()),
            Cell::Bytes(b) => Some(format!("\\x{}", hex::encode(b))),
            // Never reaches export: transfer.rs refuses placeholder rows (ensure_full_rows).
            Cell::NotLoaded | Cell::Partial { .. } => None,
        }
    }
}

pub type Row = Vec<Cell>;

/// A bind parameter. `None` binds SQL NULL. Values are sent as text and converted by
/// the server according to the target column type.
pub type Param = Option<String>;

/// Where a result column comes from, as reported by the database (absent for expressions).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnOrigin {
    pub schema: String,
    pub table: String,
    pub column: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    /// Server type name when known (empty for drivers that do not report it).
    pub type_name: String,
    /// Base table column this result column was read from, when the driver reports it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<ColumnOrigin>,
    /// A deferred column of an opened table: its cells are `Cell::NotLoaded`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deferred: bool,
}

impl ColumnMeta {
    pub fn new(name: impl Into<String>, type_name: impl Into<String>) -> Self {
        Self { name: name.into(), type_name: type_name.into(), origin: None, deferred: false }
    }

    pub fn deferred(name: impl Into<String>, type_name: impl Into<String>) -> Self {
        Self { deferred: true, ..Self::new(name, type_name) }
    }

    pub fn with_origin(mut self, origin: Option<ColumnOrigin>) -> Self {
        self.origin = origin;
        self
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowSet {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Row>,
    /// True when the row cap was reached and further rows were not fetched.
    pub truncated: bool,
}

/// Outcome of one statement of a script.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StatementOutcome {
    #[serde(rename_all = "camelCase")]
    Rows { rows: RowSet },
    #[serde(rename_all = "camelCase")]
    Affected { rows_affected: u64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObjectKind {
    #[default]
    Table,
    View,
    MaterializedView,
    ForeignTable,
    Function,
    Procedure,
    Sequence,
}

impl ObjectKind {
    pub fn is_relation(self) -> bool {
        matches!(self, Self::Table | Self::View | Self::MaterializedView | Self::ForeignTable)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbObject {
    pub schema: String,
    pub name: String,
    pub kind: ObjectKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_rows: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default: Option<String>,
    /// 1-based position within the primary key, if part of it.
    pub primary_key: Option<u32>,
    pub auto_increment: bool,
    pub comment: Option<String>,
    /// Computed by the database (`GENERATED ALWAYS AS …`); it can't be written.
    #[serde(default)]
    pub generated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
    pub definition: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub ref_schema: String,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    pub on_update: String,
    pub on_delete: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstraintInfo {
    pub name: String,
    pub kind: String,
    pub definition: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerInfo {
    pub name: String,
    pub timing: String,
    pub event: String,
    pub definition: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableStructure {
    pub schema: String,
    pub name: String,
    pub kind: ObjectKind,
    pub columns: Vec<ColumnInfo>,
    pub indexes: Vec<IndexInfo>,
    pub foreign_keys: Vec<ForeignKeyInfo>,
    pub constraints: Vec<ConstraintInfo>,
    pub triggers: Vec<TriggerInfo>,
}

impl TableStructure {
    pub fn primary_key(&self) -> Vec<&ColumnInfo> {
        let mut pk: Vec<&ColumnInfo> = self.columns.iter().filter(|c| c.primary_key.is_some()).collect();
        pk.sort_by_key(|c| c.primary_key);
        pk
    }

    pub fn column(&self, name: &str) -> Option<&ColumnInfo> {
        self.columns.iter().find(|c| c.name == name)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub product: String,
    pub version: String,
    pub current_database: String,
    pub current_user: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelSupport {
    /// Protocol-level cancel request (PostgreSQL).
    Native,
    /// `KILL QUERY` issued from a second connection (MySQL/MariaDB).
    KillQuery,
    /// `sqlite3_interrupt` on the same handle.
    Interrupt,
    /// TDS attention signal on the same connection (SQL Server).
    Attention,
}

/// What a driver can actually do. The UI uses this to hide unsupported actions instead
/// of letting them fail.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub multiple_databases: bool,
    pub schemas: bool,
    pub cancel: CancelSupport,
    pub transactions: bool,
    pub transactional_ddl: bool,
    pub explain: bool,
    pub explain_analyze: bool,
    pub materialized_views: bool,
    pub routines: bool,
    pub sequences: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_cells_serialize_as_tagged_objects() {
        assert_eq!(serde_json::to_string(&Cell::NotLoaded).unwrap(), r#"{"$notLoaded":true}"#);
        assert_eq!(
            serde_json::to_string(&Cell::Partial { preview: "ab".into(), length: 9000 }).unwrap(),
            r#"{"$partial":"ab","length":9000}"#
        );
        let deferred = ColumnMeta::deferred("body", "text");
        assert_eq!(serde_json::to_string(&deferred).unwrap(), r#"{"name":"body","typeName":"text","deferred":true}"#);
        assert_eq!(
            serde_json::to_string(&ColumnMeta::new("id", "int4")).unwrap(),
            r#"{"name":"id","typeName":"int4"}"#
        );
    }

    #[test]
    fn cells_serialize_compactly() {
        let row = vec![Cell::Null, Cell::Text("42".into()), Cell::Bytes(vec![0xde, 0xad])];
        assert_eq!(serde_json::to_string(&row).unwrap(), r#"[null,"42",{"$bytes":"dead","size":2}]"#);
    }

    #[test]
    fn large_bytes_are_previewed() {
        let c = Cell::Bytes(vec![1; BYTES_PREVIEW_LIMIT + 10]);
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v["size"], BYTES_PREVIEW_LIMIT + 10);
        assert_eq!(v["$bytes"].as_str().unwrap().len(), BYTES_PREVIEW_LIMIT * 2);
    }
}
