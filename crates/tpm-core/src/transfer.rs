//! Import and export.
//!
//! Exports stream rows through a [`RowSink`] so a whole table never has to sit in memory.
//! Imports read files incrementally, infer column types from a sample and produce
//! parameterised multi-row INSERT batches. Imported files are treated as untrusted:
//! sizes are bounded, identifiers come from the target table's structure, and values are
//! always bound as parameters.

use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::adapters::ParamStatement;
use crate::dialect::Dialect;
use crate::error::{AppError, ErrorKind, Result};
use crate::model::{Cell, ColumnMeta, Param, Row};

/// JSON array imports are parsed in memory; anything bigger should use JSON Lines.
pub const MAX_JSON_ARRAY_BYTES: u64 = 256 * 1024 * 1024;
/// Upper bound on a single text field read from an import file.
pub const MAX_FIELD_BYTES: usize = 64 * 1024 * 1024;
/// Excel's hard row limit (including the header).
const XLSX_MAX_ROWS: u64 = 1_048_576;

/// Export rows must hold full values. Placeholders (`NotLoaded`, `Partial`) belong to the grid only.
fn ensure_full_rows(rows: &[Row]) -> Result<()> {
    if rows.iter().flatten().any(|c| matches!(c, Cell::NotLoaded | Cell::Partial { .. })) {
        return Err(AppError::internal("Export received placeholder values instead of full rows"));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    Csv,
    Json,
    JsonLines,
    Sql,
    Xlsx,
}

impl ExportFormat {
    pub fn extensions(self) -> &'static [&'static str] {
        match self {
            ExportFormat::Csv => &["csv", "tsv", "txt"],
            ExportFormat::Json => &["json"],
            ExportFormat::JsonLines => &["jsonl", "ndjson"],
            ExportFormat::Sql => &["sql"],
            ExportFormat::Xlsx => &["xlsx"],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub format: ExportFormat,
    #[serde(default = "comma")]
    pub delimiter: char,
    #[serde(default = "yes")]
    pub header: bool,
    /// How NULL is written to CSV (empty string by default).
    #[serde(default)]
    pub null_text: String,
    /// Table name used in INSERT statements for SQL exports.
    #[serde(default)]
    pub sql_table: Option<String>,
    /// Schema of that table, kept apart so a dot in its name is not taken as a separator.
    #[serde(default)]
    pub sql_schema: Option<String>,
    #[serde(default)]
    pub dialect: Option<Dialect>,
    /// Rows per INSERT statement in SQL exports.
    #[serde(default = "default_sql_batch")]
    pub sql_batch: usize,
}

fn comma() -> char {
    ','
}
fn yes() -> bool {
    true
}
fn default_sql_batch() -> usize {
    100
}

/// Validates an export destination: absolute, parent directory exists, not a directory,
/// and an extension that matches the format (guards against writing over unrelated files
/// through a mistyped path).
pub fn validate_export_path(path: &str, format: ExportFormat) -> Result<PathBuf> {
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err(AppError::file("Choose an absolute file path"));
    }
    if p.is_dir() {
        return Err(AppError::file("The destination is a folder"));
    }
    match p.parent() {
        Some(dir) if dir.is_dir() => {}
        _ => return Err(AppError::file("The destination folder does not exist")),
    }
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if !format.extensions().contains(&ext.as_str()) {
        return Err(AppError::file(format!("The file name must end in .{} for this format", format.extensions()[0])));
    }
    Ok(p)
}

/// Destination for exported rows.
pub trait RowSink: Send {
    fn begin(&mut self, columns: &[ColumnMeta]) -> Result<()>;
    fn write_rows(&mut self, rows: &[Row]) -> Result<()>;
    fn finish(self: Box<Self>) -> Result<()>;
}

pub fn open_sink(path: &Path, opts: &ExportOptions) -> Result<Box<dyn RowSink>> {
    Ok(match opts.format {
        ExportFormat::Xlsx => Box::new(XlsxSink::new(path)),
        _ => {
            let file =
                File::create(path).map_err(|e| AppError::file(format!("Cannot create {}: {e}", path.display())))?;
            let out = BufWriter::with_capacity(256 * 1024, file);
            match opts.format {
                ExportFormat::Csv => Box::new(CsvSink::new(out, opts)),
                ExportFormat::Json => Box::new(JsonSink { out, columns: vec![], first: true, lines: false }),
                ExportFormat::JsonLines => Box::new(JsonSink { out, columns: vec![], first: true, lines: true }),
                ExportFormat::Sql => Box::new(SqlSink::new(out, opts)?),
                ExportFormat::Xlsx => unreachable!(),
            }
        }
    })
}

/// Rows as text in a text export format (JSON, JSON lines, CSV or SQL INSERTs), for the clipboard.
/// The same code writes export files, so values are quoted and escaped the same way.
pub fn rows_as_text(columns: &[ColumnMeta], rows: &[Row], opts: &ExportOptions) -> Result<String> {
    let buf = SharedBuf::default();
    let mut sink: Box<dyn RowSink> = match opts.format {
        ExportFormat::Csv => Box::new(CsvSink::new(buf.clone(), opts)),
        ExportFormat::Json => Box::new(JsonSink { out: buf.clone(), columns: vec![], first: true, lines: false }),
        ExportFormat::JsonLines => Box::new(JsonSink { out: buf.clone(), columns: vec![], first: true, lines: true }),
        ExportFormat::Sql => Box::new(SqlSink::new(buf.clone(), opts)?),
        ExportFormat::Xlsx => return Err(AppError::invalid_config("Excel is not a text format")),
    };
    sink.begin(columns)?;
    sink.write_rows(rows)?;
    sink.finish()?;
    let bytes = std::mem::take(&mut *buf.0.lock().map_err(|_| AppError::internal("copy buffer poisoned"))?);
    String::from_utf8(bytes).map_err(|e| AppError::internal(e.to_string()))
}

/// A grid cell as the UI holds it (text, null, or `{"$bytes": hex, "size": n}`), for copying. A
/// binary value the UI has only in part, or a value not loaded yet, is refused.
pub fn cell_from_ui(value: &serde_json::Value) -> Result<Cell> {
    use serde_json::Value;
    match value {
        Value::Null => Ok(Cell::Null),
        Value::String(s) => Ok(Cell::Text(s.clone())),
        Value::Object(m) => {
            let Some(hex_text) = m.get("$bytes").and_then(Value::as_str) else {
                return Err(AppError::invalid_config("Load every value before copying the rows"));
            };
            let bytes =
                hex::decode(hex_text).map_err(|_| AppError::invalid_config("A binary value is not valid hex"))?;
            if m.get("size").and_then(Value::as_u64) != Some(bytes.len() as u64) {
                return Err(AppError::invalid_config(
                    "A binary value over 4 KB is shown only in part, so it can't be copied; export the rows instead",
                ));
            }
            Ok(Cell::Bytes(bytes))
        }
        _ => Err(AppError::invalid_config("Unexpected value in the copied rows")),
    }
}

/// An in-memory writer the sinks can own while the caller keeps the bytes.
#[derive(Clone, Default)]
struct SharedBuf(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

impl Write for SharedBuf {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.0.lock().map_err(|_| std::io::Error::other("copy buffer poisoned"))?.extend_from_slice(data);
        Ok(data.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn io_err(e: impl std::fmt::Display) -> AppError {
    AppError::file(format!("Write failed: {e}"))
}

struct CsvSink<W: Write> {
    writer: csv::Writer<W>,
    header: bool,
    null_text: String,
}

impl<W: Write> CsvSink<W> {
    fn new(out: W, opts: &ExportOptions) -> Self {
        let mut b = csv::WriterBuilder::new();
        b.delimiter(if opts.delimiter.is_ascii() { opts.delimiter as u8 } else { b',' });
        Self { writer: b.from_writer(out), header: opts.header, null_text: opts.null_text.clone() }
    }
}

impl<W: Write + Send> RowSink for CsvSink<W> {
    fn begin(&mut self, columns: &[ColumnMeta]) -> Result<()> {
        if self.header {
            self.writer.write_record(columns.iter().map(|c| c.name.as_str())).map_err(io_err)?;
        }
        Ok(())
    }
    fn write_rows(&mut self, rows: &[Row]) -> Result<()> {
        ensure_full_rows(rows)?;
        for row in rows {
            let fields: Vec<String> =
                row.iter().map(|c| c.to_export_string().unwrap_or_else(|| self.null_text.clone())).collect();
            self.writer.write_record(&fields).map_err(io_err)?;
        }
        Ok(())
    }
    fn finish(mut self: Box<Self>) -> Result<()> {
        self.writer.flush().map_err(io_err)
    }
}

struct JsonSink<W: Write> {
    out: W,
    columns: Vec<String>,
    first: bool,
    lines: bool,
}

impl<W: Write + Send> RowSink for JsonSink<W> {
    fn begin(&mut self, columns: &[ColumnMeta]) -> Result<()> {
        self.columns = columns.iter().map(|c| c.name.clone()).collect();
        if !self.lines {
            self.out.write_all(b"[").map_err(io_err)?;
        }
        Ok(())
    }
    fn write_rows(&mut self, rows: &[Row]) -> Result<()> {
        ensure_full_rows(rows)?;
        for row in rows {
            // Written field by field: a serde_json map would sort the keys, not keep column order.
            let mut obj = String::from("{");
            for (i, (name, cell)) in self.columns.iter().zip(row).enumerate() {
                if i > 0 {
                    obj.push(',');
                }
                obj.push_str(&serde_json::to_string(name)?);
                obj.push(':');
                obj.push_str(&serde_json::to_string(&cell.to_export_string())?);
            }
            obj.push('}');
            if self.lines {
                writeln!(self.out, "{obj}").map_err(io_err)?;
            } else {
                self.out.write_all(if self.first { b"\n  " } else { b",\n  " }).map_err(io_err)?;
                self.out.write_all(obj.as_bytes()).map_err(io_err)?;
            }
            self.first = false;
        }
        Ok(())
    }
    fn finish(mut self: Box<Self>) -> Result<()> {
        if !self.lines {
            self.out.write_all(if self.first { b"]\n" } else { b"\n]\n" }).map_err(io_err)?;
        }
        self.out.flush().map_err(io_err)
    }
}

struct SqlSink<W: Write> {
    out: W,
    dialect: Dialect,
    table: String,
    columns: String,
    batch: usize,
    pending: Vec<String>,
    /// The "Exported by" comment line (off for the clipboard).
    header: bool,
}

impl<W: Write> SqlSink<W> {
    fn new(out: W, opts: &ExportOptions) -> Result<Self> {
        let dialect = opts.dialect.unwrap_or(Dialect::Postgres);
        let table = opts.sql_table.clone().filter(|t| !t.trim().is_empty()).unwrap_or_else(|| "exported".into());
        let table = match (opts.sql_schema.as_deref().filter(|s| !s.is_empty()), table.split_once('.')) {
            (Some(schema), _) => dialect.qualified(Some(schema), &table)?,
            // Without a separate schema, a dotted name is treated as schema.table.
            (None, Some((s, t))) => dialect.qualified(Some(s), t)?,
            (None, None) => dialect.quote_ident(&table)?,
        };
        Ok(Self {
            out,
            dialect,
            table,
            columns: String::new(),
            batch: opts.sql_batch.clamp(1, 10_000),
            pending: vec![],
            header: opts.header,
        })
    }

    fn flush_batch(&mut self) -> Result<()> {
        if self.pending.is_empty() {
            return Ok(());
        }
        if self.pending.len() == 1 {
            writeln!(self.out, "INSERT INTO {} ({}) VALUES {};", self.table, self.columns, self.pending[0])
        } else {
            writeln!(
                self.out,
                "INSERT INTO {} ({}) VALUES\n  {};",
                self.table,
                self.columns,
                self.pending.join(",\n  ")
            )
        }
        .map_err(io_err)?;
        self.pending.clear();
        Ok(())
    }
}

impl<W: Write + Send> RowSink for SqlSink<W> {
    fn begin(&mut self, columns: &[ColumnMeta]) -> Result<()> {
        let cols: Result<Vec<String>> = columns.iter().map(|c| self.dialect.quote_ident(&c.name)).collect();
        self.columns = cols?.join(", ");
        if self.header {
            writeln!(self.out, "-- Exported by Table Pro Max").map_err(io_err)?;
        }
        Ok(())
    }
    fn write_rows(&mut self, rows: &[Row]) -> Result<()> {
        ensure_full_rows(rows)?;
        for row in rows {
            let values: Vec<String> = row
                .iter()
                .map(|c| match c {
                    Cell::Null => "NULL".to_string(),
                    Cell::Text(t) => self.dialect.quote_literal(t),
                    Cell::Bytes(b) => match self.dialect {
                        Dialect::Postgres => format!("'\\x{}'::bytea", hex::encode(b)),
                        _ => format!("X'{}'", hex::encode(b)),
                    },
                    Cell::NotLoaded | Cell::Partial { .. } => unreachable!("rejected by ensure_full_rows"),
                })
                .collect();
            self.pending.push(format!("({})", values.join(", ")));
            if self.pending.len() >= self.batch {
                self.flush_batch()?;
            }
        }
        Ok(())
    }
    fn finish(mut self: Box<Self>) -> Result<()> {
        self.flush_batch()?;
        self.out.flush().map_err(io_err)
    }
}

struct XlsxSink {
    path: PathBuf,
    workbook: rust_xlsxwriter::Workbook,
    row: u32,
    numeric: Vec<bool>,
}

impl XlsxSink {
    fn new(path: &Path) -> Self {
        let mut workbook = rust_xlsxwriter::Workbook::new();
        workbook.add_worksheet_with_constant_memory();
        Self { path: path.to_path_buf(), workbook, row: 0, numeric: vec![] }
    }
}

fn xlsx_err(e: rust_xlsxwriter::XlsxError) -> AppError {
    AppError::file(format!("Excel export failed: {e}"))
}

impl RowSink for XlsxSink {
    fn begin(&mut self, columns: &[ColumnMeta]) -> Result<()> {
        if columns.len() > 16_384 {
            return Err(AppError::file("Excel supports at most 16,384 columns"));
        }
        self.numeric = columns.iter().map(|c| crate::transfer::is_numeric_type(&c.type_name)).collect();
        let bold = rust_xlsxwriter::Format::new().set_bold();
        let ws = self.workbook.worksheet_from_index(0).map_err(xlsx_err)?;
        for (i, c) in columns.iter().enumerate() {
            ws.write_string_with_format(0, i as u16, &c.name, &bold).map_err(xlsx_err)?;
        }
        self.row = 1;
        Ok(())
    }
    fn write_rows(&mut self, rows: &[Row]) -> Result<()> {
        ensure_full_rows(rows)?;
        if self.row as u64 + rows.len() as u64 > XLSX_MAX_ROWS {
            return Err(AppError::file("Excel supports at most 1,048,576 rows; use CSV for larger exports"));
        }
        let ws = self.workbook.worksheet_from_index(0).map_err(xlsx_err)?;
        for row in rows {
            for (i, cell) in row.iter().enumerate() {
                let col = i as u16;
                match cell {
                    Cell::Null => {}
                    Cell::Text(t) => {
                        // Numbers stay numbers when the column type says so and the value
                        // round-trips; otherwise keep the exact text.
                        match (self.numeric.get(i).copied().unwrap_or(false), t.parse::<f64>()) {
                            (true, Ok(n)) if n.is_finite() && t.len() <= 15 => {
                                ws.write_number(self.row, col, n).map_err(xlsx_err)?;
                            }
                            _ => {
                                let s: String = t.chars().take(32_767).collect();
                                ws.write_string(self.row, col, s).map_err(xlsx_err)?;
                            }
                        }
                    }
                    Cell::Bytes(b) => {
                        ws.write_string(self.row, col, format!("\\x{}", hex::encode(&b[..b.len().min(16_000)])))
                            .map_err(xlsx_err)?;
                    }
                    Cell::NotLoaded | Cell::Partial { .. } => unreachable!("rejected by ensure_full_rows"),
                }
            }
            self.row += 1;
        }
        Ok(())
    }
    fn finish(mut self: Box<Self>) -> Result<()> {
        self.workbook.save(&self.path).map_err(xlsx_err)
    }
}

pub(crate) fn is_numeric_type(t: &str) -> bool {
    let t = t.to_ascii_lowercase();
    ["int", "numeric", "decimal", "real", "double", "float", "serial", "money", "number"].iter().any(|k| t.contains(k))
}

// ---------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportFormat {
    Csv,
    Json,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Encoding {
    #[default]
    Utf8,
    /// ISO-8859-1 (each byte is one code point).
    Latin1,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOptions {
    pub format: ImportFormat,
    #[serde(default = "comma")]
    pub delimiter: char,
    #[serde(default = "dquote")]
    pub quote: char,
    #[serde(default = "yes")]
    pub header: bool,
    #[serde(default)]
    pub encoding: Encoding,
    /// Field values that become SQL NULL (exact match). An empty list means "never".
    #[serde(default = "default_nulls")]
    pub null_values: Vec<String>,
    /// Trim surrounding whitespace from fields.
    #[serde(default)]
    pub trim: bool,
}

fn dquote() -> char {
    '"'
}
fn default_nulls() -> Vec<String> {
    vec![String::new(), "NULL".into()]
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InferredColumn {
    pub name: String,
    /// Portable type family: integer, decimal, boolean, date, timestamp, text.
    pub kind: String,
    pub nullable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub columns: Vec<InferredColumn>,
    pub rows: Vec<Vec<Option<String>>>,
    pub file_bytes: u64,
}

/// A streaming source of import records (each a list of optional text values).
pub struct RecordReader {
    inner: RecordInner,
    opts: ImportOptions,
    pub headers: Vec<String>,
}

enum RecordInner {
    Csv(csv::Reader<Box<dyn Read + Send>>),
    Json(std::vec::IntoIter<serde_json::Map<String, serde_json::Value>>),
    JsonLines(std::io::Lines<BufReader<File>>),
}

fn decode(bytes: &[u8], enc: Encoding) -> String {
    match enc {
        Encoding::Utf8 => String::from_utf8_lossy(bytes).into_owned(),
        Encoding::Latin1 => bytes.iter().map(|&b| b as char).collect(),
    }
}

fn json_to_text(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::Null => None,
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        other => Some(other.to_string()),
    }
}

impl RecordReader {
    pub fn open(path: &Path, opts: &ImportOptions) -> Result<Self> {
        let meta =
            std::fs::metadata(path).map_err(|e| AppError::file(format!("Cannot read {}: {e}", path.display())))?;
        if !meta.is_file() {
            return Err(AppError::file("Choose a file to import"));
        }
        match opts.format {
            ImportFormat::Csv => {
                let file = File::open(path)?;
                let mut reader: Box<dyn Read + Send> = Box::new(BufReader::with_capacity(256 * 1024, file));
                // Skip a UTF-8 byte-order mark.
                let mut bom = [0u8; 3];
                let n = reader.read(&mut bom)?;
                let prefix: Vec<u8> = if n == 3 && bom == [0xEF, 0xBB, 0xBF] { vec![] } else { bom[..n].to_vec() };
                let reader: Box<dyn Read + Send> = Box::new(std::io::Cursor::new(prefix).chain(reader));
                let delim = if opts.delimiter.is_ascii() { opts.delimiter as u8 } else { b',' };
                let quote = if opts.quote.is_ascii() { opts.quote as u8 } else { b'"' };
                let mut csv = csv::ReaderBuilder::new()
                    .delimiter(delim)
                    .quote(quote)
                    .has_headers(false)
                    .flexible(true)
                    .from_reader(reader);
                let mut headers = Vec::new();
                if opts.header {
                    let mut rec = csv::ByteRecord::new();
                    if csv.read_byte_record(&mut rec).map_err(csv_err)? {
                        headers = rec.iter().map(|f| decode(f, opts.encoding).trim().to_string()).collect();
                    }
                }
                Ok(Self { inner: RecordInner::Csv(csv), opts: opts.clone(), headers })
            }
            ImportFormat::Json => {
                let mut file = BufReader::new(File::open(path)?);
                let mut first = [0u8; 1];
                // Peek the first non-whitespace byte: '[' means an array, otherwise JSON Lines.
                loop {
                    if file.read(&mut first)? == 0 {
                        return Err(AppError::file("The file is empty"));
                    }
                    if !first[0].is_ascii_whitespace() {
                        break;
                    }
                }
                if first[0] == b'[' {
                    if meta.len() > MAX_JSON_ARRAY_BYTES {
                        return Err(AppError::file(
                            "JSON arrays larger than 256 MB are not supported; use JSON Lines (one object per line)",
                        ));
                    }
                    let mut rest = Vec::with_capacity(meta.len() as usize);
                    rest.push(b'[');
                    file.read_to_end(&mut rest)?;
                    let values: Vec<serde_json::Value> = serde_json::from_slice(&rest)
                        .map_err(|e| AppError::new(ErrorKind::File, format!("Invalid JSON: {e}")))?;
                    let mut objects = Vec::with_capacity(values.len());
                    for v in values {
                        match v {
                            serde_json::Value::Object(o) => objects.push(o),
                            _ => return Err(AppError::file("Each element of the JSON array must be an object")),
                        }
                    }
                    let headers = union_keys(objects.iter().take(1000));
                    Ok(Self { inner: RecordInner::Json(objects.into_iter()), opts: opts.clone(), headers })
                } else {
                    // JSON Lines: collect headers from the first lines, then reopen to stream.
                    let mut headers = Vec::new();
                    {
                        use std::io::BufRead;
                        let reader = BufReader::new(File::open(path)?);
                        let mut sample = Vec::new();
                        for line in reader.lines().take(1000) {
                            let line = line?;
                            if line.trim().is_empty() {
                                continue;
                            }
                            if let Ok(serde_json::Value::Object(o)) = serde_json::from_str(&line) {
                                sample.push(o);
                            }
                        }
                        headers.extend(union_keys(sample.iter()));
                    }
                    use std::io::BufRead;
                    let lines = BufReader::new(File::open(path)?).lines();
                    Ok(Self { inner: RecordInner::JsonLines(lines), opts: opts.clone(), headers })
                }
            }
        }
    }

    fn clean(&self, s: String) -> Option<String> {
        let s = if self.opts.trim { s.trim().to_string() } else { s };
        if self.opts.null_values.contains(&s) { None } else { Some(s) }
    }

    /// Next record, or `None` at end of file.
    pub fn next_record(&mut self) -> Result<Option<Vec<Option<String>>>> {
        match &mut self.inner {
            RecordInner::Csv(r) => {
                let mut rec = csv::ByteRecord::new();
                if !r.read_byte_record(&mut rec).map_err(csv_err)? {
                    return Ok(None);
                }
                if rec.iter().any(|f| f.len() > MAX_FIELD_BYTES) {
                    return Err(AppError::file("A field is larger than 64 MB"));
                }
                let enc = self.opts.encoding;
                let fields: Vec<String> = rec.iter().map(|f| decode(f, enc)).collect();
                Ok(Some(fields.into_iter().map(|f| self.clean(f)).collect()))
            }
            RecordInner::Json(it) => {
                let headers = self.headers.clone();
                Ok(it.next().map(|o| headers.iter().map(|h| o.get(h).and_then(json_to_text)).collect()))
            }
            RecordInner::JsonLines(lines) => loop {
                let Some(line) = lines.next() else { return Ok(None) };
                let line = line?;
                if line.trim().is_empty() {
                    continue;
                }
                let v: serde_json::Value = serde_json::from_str(&line)
                    .map_err(|e| AppError::new(ErrorKind::File, format!("Invalid JSON line: {e}")))?;
                let serde_json::Value::Object(o) = v else {
                    return Err(AppError::file("Each JSON line must be an object"));
                };
                return Ok(Some(self.headers.iter().map(|h| o.get(h).and_then(json_to_text)).collect()));
            },
        }
    }
}

fn csv_err(e: csv::Error) -> AppError {
    AppError::new(ErrorKind::File, format!("Could not read CSV: {e}"))
}

fn union_keys<'a>(objects: impl Iterator<Item = &'a serde_json::Map<String, serde_json::Value>>) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    for o in objects {
        for k in o.keys() {
            if !keys.contains(k) {
                keys.push(k.clone());
            }
        }
    }
    keys
}

/// Reads up to `sample` records and infers a type family per column.
pub fn preview(path: &Path, opts: &ImportOptions, sample: usize) -> Result<ImportPreview> {
    let file_bytes = std::fs::metadata(path)?.len();
    let mut reader = RecordReader::open(path, opts)?;
    let mut rows = Vec::new();
    while rows.len() < sample {
        match reader.next_record()? {
            Some(r) => rows.push(r),
            None => break,
        }
    }
    let width = rows.iter().map(Vec::len).max().unwrap_or(0).max(reader.headers.len());
    let columns = (0..width)
        .map(|i| {
            let name =
                reader.headers.get(i).filter(|h| !h.is_empty()).cloned().unwrap_or_else(|| format!("column_{}", i + 1));
            let values: Vec<Option<&str>> = rows.iter().map(|r| r.get(i).and_then(|v| v.as_deref())).collect();
            InferredColumn {
                name,
                kind: infer_kind(values.iter().filter_map(|v| *v)).into(),
                nullable: values.iter().any(Option::is_none),
            }
        })
        .collect();
    Ok(ImportPreview { columns, rows: rows.into_iter().take(50).collect(), file_bytes })
}

pub fn infer_kind<'a>(values: impl Iterator<Item = &'a str>) -> &'static str {
    let mut int = true;
    let mut dec = true;
    let mut boolean = true;
    let mut date = true;
    let mut ts = true;
    let mut any = false;
    for v in values {
        any = true;
        let v = v.trim();
        // Leading zeros (ZIP codes, phone numbers, IDs) must stay text or they are lost.
        let digits = v.trim_start_matches(['-', '+']);
        let leading_zero = digits.len() > 1 && digits.starts_with('0') && !digits.starts_with("0.");
        int &= !leading_zero && v.parse::<i64>().is_ok();
        dec &= !leading_zero && v.parse::<f64>().map(|f| f.is_finite()).unwrap_or(false);
        boolean &= matches!(v.to_ascii_lowercase().as_str(), "true" | "false" | "t" | "f" | "yes" | "no");
        date &= is_date(v);
        ts &= is_timestamp(v);
        if !(int || dec || boolean || date || ts) {
            return "text";
        }
    }
    if !any {
        "text"
    } else if int {
        "integer"
    } else if dec {
        "decimal"
    } else if boolean {
        "boolean"
    } else if date {
        "date"
    } else if ts {
        "timestamp"
    } else {
        "text"
    }
}

fn is_date(v: &str) -> bool {
    let b = v.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

fn is_timestamp(v: &str) -> bool {
    v.len() >= 19 && is_date(&v[..10]) && matches!(v.as_bytes()[10], b' ' | b'T') && v.as_bytes()[13] == b':'
}

/// Database type for an inferred type family.
pub fn sql_type(dialect: Dialect, kind: &str) -> &'static str {
    match (dialect, kind) {
        (Dialect::Postgres, "integer") => "bigint",
        (Dialect::Postgres, "decimal") => "numeric",
        (Dialect::Postgres, "boolean") => "boolean",
        (Dialect::Postgres, "date") => "date",
        (Dialect::Postgres, "timestamp") => "timestamp",
        (Dialect::Postgres, _) => "text",
        (Dialect::Mysql, "integer") => "bigint",
        (Dialect::Mysql, "decimal") => "double",
        (Dialect::Mysql, "boolean") => "boolean",
        (Dialect::Mysql, "date") => "date",
        (Dialect::Mysql, "timestamp") => "datetime(6)",
        (Dialect::Mysql, _) => "text",
        (Dialect::Sqlite, "integer") => "INTEGER",
        (Dialect::Sqlite, "decimal") => "REAL",
        (Dialect::Sqlite, _) => "TEXT",
    }
}

/// Maps file columns to table columns: `mapping[i] = Some(source_index)` for target column i.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMapping {
    pub target: String,
    pub source: usize,
}

/// Builds a parameterised multi-row INSERT for one batch of records.
pub fn insert_batch(
    dialect: Dialect,
    table: &str,
    targets: &[String],
    mapping: &[ColumnMapping],
    records: &[Vec<Option<String>>],
) -> ParamStatement {
    let width = mapping.len();
    let mut params: Vec<Param> = Vec::with_capacity(records.len() * width);
    let mut groups = Vec::with_capacity(records.len());
    for rec in records {
        let mut ph = Vec::with_capacity(width);
        for m in mapping {
            params.push(rec.get(m.source).cloned().flatten());
            ph.push(dialect.placeholder(params.len()));
        }
        groups.push(format!("({})", ph.join(", ")));
    }
    ParamStatement {
        sql: format!("INSERT INTO {table} ({}) VALUES {}", targets.join(", "), groups.join(", ")),
        params,
        expect_rows: Some(records.len() as u64),
    }
}

/// Rows per INSERT so that one statement stays under every driver's parameter limit
/// (SQLite's default is 32,766).
pub fn batch_rows(columns: usize) -> usize {
    (30_000 / columns.max(1)).clamp(1, 1000)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cols() -> Vec<ColumnMeta> {
        vec![ColumnMeta::new("id", "integer"), ColumnMeta::new("name", "text"), ColumnMeta::new("data", "bytea")]
    }

    fn rows() -> Vec<Row> {
        vec![
            vec![Cell::Text("1".into()), Cell::Text("a,b \"q\"".into()), Cell::Bytes(vec![0xde, 0xad])],
            vec![Cell::Text("2".into()), Cell::Null, Cell::Null],
        ]
    }

    fn export(format: ExportFormat, ext: &str, f: impl FnOnce(&mut ExportOptions)) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(format!("out.{ext}"));
        let mut opts = ExportOptions {
            format,
            delimiter: ',',
            header: true,
            null_text: String::new(),
            sql_table: Some("public.items".into()),
            sql_schema: None,
            dialect: Some(Dialect::Postgres),
            sql_batch: 100,
        };
        f(&mut opts);
        let mut sink = open_sink(&path, &opts).unwrap();
        sink.begin(&cols()).unwrap();
        sink.write_rows(&rows()).unwrap();
        sink.finish().unwrap();
        (dir, path)
    }

    #[test]
    fn csv_export_quotes_and_nulls() {
        let (_d, p) = export(ExportFormat::Csv, "csv", |o| o.null_text = "NULL".into());
        let s = std::fs::read_to_string(p).unwrap();
        assert_eq!(s, "id,name,data\n1,\"a,b \"\"q\"\"\",\\xdead\n2,NULL,NULL\n");
    }

    #[test]
    fn json_and_jsonl_exports_are_valid() {
        let (_d, p) = export(ExportFormat::Json, "json", |_| {});
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
        assert_eq!(v[0]["name"], "a,b \"q\"");
        assert!(v[1]["name"].is_null());
        let (_d, p) = export(ExportFormat::JsonLines, "jsonl", |_| {});
        let s = std::fs::read_to_string(p).unwrap();
        assert_eq!(s.lines().count(), 2);
        for l in s.lines() {
            serde_json::from_str::<serde_json::Value>(l).unwrap();
        }
    }

    #[test]
    fn sql_export_escapes_values() {
        let (_d, p) = export(ExportFormat::Sql, "sql", |_| {});
        let s = std::fs::read_to_string(p).unwrap();
        assert!(s.contains("INSERT INTO \"public\".\"items\" (\"id\", \"name\", \"data\") VALUES"), "{s}");
        assert!(s.contains("('1', 'a,b \"q\"', '\\xdead'::bytea)"), "{s}");
        assert!(s.contains("('2', NULL, NULL);"));
    }

    #[test]
    fn rows_copy_as_insert_statements_and_json() {
        let opts = |format| ExportOptions {
            format,
            delimiter: ',',
            header: false,
            null_text: String::new(),
            sql_table: Some("public.items".into()),
            sql_schema: None,
            dialect: Some(Dialect::Postgres),
            sql_batch: 1,
        };
        let sql = rows_as_text(&cols(), &rows(), &opts(ExportFormat::Sql)).unwrap();
        assert_eq!(
            sql,
            "INSERT INTO \"public\".\"items\" (\"id\", \"name\", \"data\") VALUES ('1', 'a,b \"q\"', '\\xdead'::bytea);\n\
             INSERT INTO \"public\".\"items\" (\"id\", \"name\", \"data\") VALUES ('2', NULL, NULL);\n"
        );
        let mysql = rows_as_text(
            &cols(),
            &rows()[1..],
            &ExportOptions { dialect: Some(Dialect::Mysql), sql_table: Some("it's".into()), ..opts(ExportFormat::Sql) },
        )
        .unwrap();
        assert_eq!(mysql, "INSERT INTO `it's` (`id`, `name`, `data`) VALUES ('2', NULL, NULL);\n");
        let json: serde_json::Value =
            serde_json::from_str(&rows_as_text(&cols(), &rows(), &opts(ExportFormat::Json)).unwrap()).unwrap();
        assert_eq!(
            json,
            serde_json::json!([{ "id": "1", "name": "a,b \"q\"", "data": "\\xdead" }, { "id": "2", "name": null, "data": null }])
        );
        assert!(rows_as_text(&cols(), &rows(), &opts(ExportFormat::Xlsx)).is_err());
        assert!(
            rows_as_text(&cols(), &[vec![Cell::NotLoaded, Cell::Null, Cell::Null]], &opts(ExportFormat::Json)).is_err()
        );
    }

    #[test]
    fn cells_from_the_grid_keep_complete_binary_values() {
        use serde_json::json;
        assert_eq!(cell_from_ui(&json!(null)).unwrap(), Cell::Null);
        assert_eq!(cell_from_ui(&json!("x")).unwrap(), Cell::Text("x".into()));
        assert_eq!(cell_from_ui(&json!({ "$bytes": "dead", "size": 2 })).unwrap(), Cell::Bytes(vec![0xde, 0xad]));
        let err = cell_from_ui(&json!({ "$bytes": "dead", "size": 9000 })).unwrap_err();
        assert!(err.message.contains("export"), "{err:?}");
        assert!(cell_from_ui(&json!({ "$bytes": "zz", "size": 1 })).is_err());
        assert!(cell_from_ui(&json!({ "$notLoaded": true })).is_err());
        assert!(cell_from_ui(&json!({ "$partial": "ab", "length": 10 })).is_err());
        assert!(cell_from_ui(&json!(5)).is_err());
    }

    #[test]
    fn a_separate_schema_keeps_dots_in_its_name() {
        let opts = ExportOptions {
            format: ExportFormat::Sql,
            delimiter: ',',
            header: false,
            null_text: String::new(),
            sql_table: Some("t".into()),
            sql_schema: Some("a.b".into()),
            dialect: Some(Dialect::Postgres),
            sql_batch: 1,
        };
        let sql = rows_as_text(&[ColumnMeta::new("x", "text")], &[vec![Cell::Null]], &opts).unwrap();
        assert_eq!(sql, "INSERT INTO \"a.b\".\"t\" (\"x\") VALUES (NULL);\n");
    }

    #[test]
    fn json_keeps_the_column_order() {
        let cols =
            vec![ColumnMeta::new("zeta", "text"), ColumnMeta::new("alpha", "text"), ColumnMeta::new("mid", "text")];
        let rows = vec![vec![Cell::Text("z".into()), Cell::Null, Cell::Text("m\"q".into())]];
        let opts = |format| ExportOptions {
            format,
            delimiter: ',',
            header: false,
            null_text: String::new(),
            sql_table: None,
            sql_schema: None,
            dialect: None,
            sql_batch: 1,
        };
        let json = rows_as_text(&cols, &rows, &opts(ExportFormat::Json)).unwrap();
        assert_eq!(json, "[\n  {\"zeta\":\"z\",\"alpha\":null,\"mid\":\"m\\\"q\"}\n]\n");
        let lines = rows_as_text(&cols, &rows, &opts(ExportFormat::JsonLines)).unwrap();
        assert_eq!(lines, "{\"zeta\":\"z\",\"alpha\":null,\"mid\":\"m\\\"q\"}\n");
    }

    #[test]
    fn xlsx_export_produces_a_zip() {
        let (_d, p) = export(ExportFormat::Xlsx, "xlsx", |_| {});
        let bytes = std::fs::read(p).unwrap();
        assert_eq!(&bytes[..2], b"PK");
    }

    #[test]
    fn export_path_validation() {
        let dir = tempfile::tempdir().unwrap();
        let ok = dir.path().join("a.csv");
        assert!(validate_export_path(ok.to_str().unwrap(), ExportFormat::Csv).is_ok());
        assert!(validate_export_path("relative.csv", ExportFormat::Csv).is_err());
        assert!(validate_export_path(dir.path().join("a.exe").to_str().unwrap(), ExportFormat::Csv).is_err());
        assert!(validate_export_path(dir.path().join("nope/a.csv").to_str().unwrap(), ExportFormat::Csv).is_err());
        assert!(validate_export_path(dir.path().to_str().unwrap(), ExportFormat::Csv).is_err());
    }

    fn import_opts(format: ImportFormat) -> ImportOptions {
        ImportOptions {
            format,
            delimiter: ',',
            quote: '"',
            header: true,
            encoding: Encoding::Utf8,
            null_values: default_nulls(),
            trim: false,
        }
    }

    #[test]
    fn csv_import_preview_and_inference() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("in.csv");
        std::fs::write(
            &path,
            "\u{feff}id,price,ok,day,at,name\n1,1.5,true,2024-01-02,2024-01-02 10:00:00,\"x, y\"\n2,2,false,2024-02-03,2024-02-03T11:00:00,NULL\n",
        )
        .unwrap();
        let p = preview(&path, &import_opts(ImportFormat::Csv), 100).unwrap();
        let kinds: Vec<&str> = p.columns.iter().map(|c| c.kind.as_str()).collect();
        assert_eq!(kinds, ["integer", "decimal", "boolean", "date", "timestamp", "text"]);
        assert_eq!(p.columns[0].name, "id", "BOM stripped from the first header");
        assert_eq!(p.rows[0][5].as_deref(), Some("x, y"));
        assert_eq!(p.rows[1][5], None);
        assert!(p.columns[5].nullable);
    }

    #[test]
    fn latin1_and_custom_delimiter() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("in.txt");
        std::fs::write(&path, b"name;city\nJos\xe9;M\xfcnchen\n").unwrap();
        let mut o = import_opts(ImportFormat::Csv);
        o.delimiter = ';';
        o.encoding = Encoding::Latin1;
        let p = preview(&path, &o, 10).unwrap();
        assert_eq!(p.rows[0], vec![Some("José".to_string()), Some("München".to_string())]);
    }

    #[test]
    fn json_array_and_lines_import() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("in.json");
        std::fs::write(&path, r#" [{"a": 1, "b": "x"}, {"a": 2, "c": {"n": true}}] "#).unwrap();
        let p = preview(&path, &import_opts(ImportFormat::Json), 10).unwrap();
        assert_eq!(p.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["a", "b", "c"]);
        assert_eq!(p.rows[1], vec![Some("2".into()), None, Some(r#"{"n":true}"#.into())]);

        let path = dir.path().join("in.jsonl");
        std::fs::write(&path, "{\"a\": 1}\n\n{\"a\": null}\n").unwrap();
        let p = preview(&path, &import_opts(ImportFormat::Json), 10).unwrap();
        assert_eq!(p.rows, vec![vec![Some("1".into())], vec![None]]);
        std::fs::write(&path, "[1, 2]").unwrap();
        assert!(preview(&path, &import_opts(ImportFormat::Json), 10).is_err());
    }

    #[test]
    fn insert_batches_are_parameterised() {
        let mapping =
            vec![ColumnMapping { target: "name".into(), source: 1 }, ColumnMapping { target: "id".into(), source: 0 }];
        let recs = vec![vec![Some("1".into()), Some("'; drop table x; --".into())], vec![Some("2".into()), None]];
        let st = insert_batch(Dialect::Sqlite, "\"t\"", &["\"name\"".into(), "\"id\"".into()], &mapping, &recs);
        assert_eq!(st.sql, "INSERT INTO \"t\" (\"name\", \"id\") VALUES (?1, ?2), (?3, ?4)");
        assert_eq!(st.params, vec![Some("'; drop table x; --".into()), Some("1".into()), None, Some("2".into())]);
        assert_eq!(st.expect_rows, Some(2));
        assert_eq!(batch_rows(3), 1000);
        assert_eq!(batch_rows(100), 300);
    }

    #[test]
    fn inference_edge_cases() {
        assert_eq!(infer_kind(["007", "1"].into_iter()), "text", "leading zeros must survive");
        assert_eq!(infer_kind(["0.5", "-0.25"].into_iter()), "decimal");
        assert_eq!(infer_kind(["0", "-3"].into_iter()), "integer");
        assert_eq!(infer_kind(std::iter::empty()), "text");
        assert_eq!(infer_kind(["1e3", "2.5"].into_iter()), "decimal");
        assert_eq!(infer_kind(["yes", "no"].into_iter()), "boolean");
    }
}
