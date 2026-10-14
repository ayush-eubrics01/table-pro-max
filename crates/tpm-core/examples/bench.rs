//! Repeatable performance check for large results and large imports.
//!
//! ```sh
//! scripts/test-db.sh up && eval "$(scripts/test-db.sh env)"
//! cargo run --release -p tpm-core --example bench            # all configured drivers
//! cargo run --release -p tpm-core --example bench -- 500000  # import row count
//! ```
//! Uses only the disposable `tpm_test` databases (plus a temporary SQLite file).

use std::sync::Arc;
use std::time::Instant;

use tpm_core::adapters::{ConnectOptions, sqlite};
use tpm_core::browse::BrowseRequest;
use tpm_core::config::{ConnectionProfile, Driver, SafetyMode, parse_connection_url};
use tpm_core::engine::{Engine, ImportRequest, RunOptions};
use tpm_core::transfer::{ColumnMapping, Encoding, ImportFormat, ImportOptions};

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let import_rows: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(200_000);
    let dir = tempfile::tempdir().unwrap();
    let csv = dir.path().join("bench.csv");
    let t0 = Instant::now();
    {
        let mut w = csv::Writer::from_path(&csv).unwrap();
        w.write_record(["id", "name", "amount", "created"]).unwrap();
        for i in 0..import_rows {
            w.write_record([
                i.to_string(),
                format!("name {i}"),
                format!("{}.{:02}", i % 1000, i % 100),
                "2026-01-02 03:04:05".into(),
            ])
            .unwrap();
        }
        w.flush().unwrap();
    }
    let size = std::fs::metadata(&csv).unwrap().len();
    println!("generated {import_rows} CSV rows ({:.1} MB) in {:?}", size as f64 / 1e6, t0.elapsed());

    let mut targets: Vec<(String, ConnectionProfile, Option<String>)> = Vec::new();
    for (var, label) in
        [("TPM_TEST_PG_URL", "PostgreSQL"), ("TPM_TEST_MYSQL_URL", "MySQL"), ("TPM_TEST_MARIADB_URL", "MariaDB")]
    {
        if let Ok(url) = std::env::var(var) {
            let p = parse_connection_url(&url).unwrap();
            targets.push((label.into(), p.profile, p.password));
        }
    }
    let db = dir.path().join("bench.sqlite");
    sqlite::create_database_file(db.to_str().unwrap()).unwrap();
    let mut sp = ConnectionProfile::new("bench", Driver::Sqlite);
    sp.file_path = Some(db.to_string_lossy().into_owned());
    targets.push(("SQLite".into(), sp, None));

    println!(
        "\n| Database | 1M-row SELECT capped at 100k | Page fetch (1k rows) | Import {import_rows} rows | Export table to CSV |"
    );
    println!("|---|---|---|---|---|");
    for (label, mut profile, password) in targets {
        profile.safety_mode = SafetyMode::Normal;
        let engine = Arc::new(Engine::new());
        let info = engine.open_session(&profile, password.as_deref(), None, ConnectOptions::default()).await.unwrap();
        let sid = info.session_id.clone();
        let big = match profile.driver {
            Driver::Postgres => "SELECT g, md5(g::text) FROM generate_series(1, 1000000) g".to_string(),
            Driver::Sqlite => "WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM r WHERE i < 1000000) SELECT i, hex(i) FROM r".into(),
            _ => {
                let d = "(SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)";
                format!("SELECT a.n + b.n*10 + c.n*100 + d.n*1000 + e.n*10000 + f.n*100000 AS v, md5(a.n) FROM {d} a, {d} b, {d} c, {d} d, {d} e, {d} f")
            }
        };
        let t = Instant::now();
        let r = engine
            .run_script(&sid, &big, RunOptions { max_rows: Some(100_000), ..Default::default() }, None)
            .await
            .unwrap();
        let select_time = t.elapsed();
        let rid = r.statements[0].result_id.clone().unwrap();
        let t = Instant::now();
        let page = engine.fetch_rows(&rid, 50_000, 1_000).unwrap();
        let page_time = t.elapsed();
        assert_eq!(page.len(), 1_000);

        let create = match profile.driver {
            Driver::Postgres => {
                "DROP TABLE IF EXISTS tpm_bench; CREATE TABLE tpm_bench (id bigint, name text, amount numeric(10,2), created timestamp)"
            }
            Driver::Sqlite => {
                "DROP TABLE IF EXISTS tpm_bench; CREATE TABLE tpm_bench (id integer, name text, amount numeric, created text)"
            }
            _ => {
                "DROP TABLE IF EXISTS tpm_bench; CREATE TABLE tpm_bench (id bigint, name varchar(64), amount decimal(10,2), created datetime)"
            }
        };
        engine.run_script(&sid, create, RunOptions { confirmed: true, ..Default::default() }, None).await.unwrap();
        let schema = match profile.driver {
            Driver::Postgres => "public".to_string(),
            Driver::Sqlite => "main".into(),
            _ => profile.database.clone(),
        };
        let req = ImportRequest {
            path: csv.to_string_lossy().into_owned(),
            options: ImportOptions {
                format: ImportFormat::Csv,
                delimiter: ',',
                quote: '"',
                header: true,
                encoding: Encoding::Utf8,
                null_values: vec![String::new()],
                trim: false,
            },
            schema: schema.clone(),
            table: "tpm_bench".into(),
            mapping: ["id", "name", "amount", "created"]
                .iter()
                .enumerate()
                .map(|(i, c)| ColumnMapping { target: c.to_string(), source: i })
                .collect(),
            skip: 0,
        };
        let t = Instant::now();
        let n = engine.import_file(&sid, &req, true, None, Arc::new(Default::default())).await.unwrap();
        let import_time = t.elapsed();
        assert_eq!(n as usize, import_rows);

        let out = dir.path().join(format!("export-{label}.csv"));
        let opts = tpm_core::transfer::ExportOptions {
            format: tpm_core::transfer::ExportFormat::Csv,
            delimiter: ',',
            header: true,
            null_text: String::new(),
            sql_table: None,
            dialect: None,
            sql_batch: 100,
        };
        let t = Instant::now();
        let sink = tpm_core::transfer::open_sink(&out, &opts).unwrap();
        let exported = engine
            .export_table(
                &sid,
                &BrowseRequest {
                    schema,
                    table: "tpm_bench".into(),
                    filter: None,
                    sort: vec![],
                    limit: 1,
                    offset: 0,
                    ..Default::default()
                },
                sink,
                None,
                Arc::new(Default::default()),
            )
            .await
            .unwrap();
        let export_time = t.elapsed();
        assert_eq!(exported as usize, import_rows);
        engine
            .run_script(&sid, "DROP TABLE tpm_bench", RunOptions { confirmed: true, ..Default::default() }, None)
            .await
            .unwrap();
        engine.close_all().await;

        let rate = |d: std::time::Duration| import_rows as f64 / d.as_secs_f64();
        println!(
            "| {label} | {:.2} s | {:.1} ms | {:.2} s ({:.0} rows/s) | {:.2} s ({:.0} rows/s) |",
            select_time.as_secs_f64(),
            page_time.as_secs_f64() * 1000.0,
            import_time.as_secs_f64(),
            rate(import_time),
            export_time.as_secs_f64(),
            rate(export_time)
        );
    }
}
