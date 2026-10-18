//! Integration tests against real database servers.
//!
//! Start disposable servers with `scripts/test-db.sh up` and export the URLs it
//! prints. A driver whose URL is not set is reported as BLOCKED and skipped; it is
//! never reported as passing. These tests create and drop their own tables in the
//! `tpm_test` database only.

use std::sync::Arc;
use std::time::{Duration, Instant};

use tpm_core::adapters::{self, ConnectOptions};
use tpm_core::browse::{BrowseRequest, SortSpec};
use tpm_core::changes::{ChangeSet, ColumnEdit, ColumnValue, EditValue, RowChange};
use tpm_core::config::{ConnectionProfile, Driver, SafetyMode, parse_connection_url};
use tpm_core::engine::{Engine, RunOptions};
use tpm_core::error::ErrorKind;
use tpm_core::filter::{FilterNode, FilterOp, Logic};
use tpm_core::model::{Cell, ObjectKind, StatementOutcome};

struct Target {
    profile: ConnectionProfile,
    password: Option<String>,
    schema: String,
    sleep_sql: &'static str,
    big_query: String,
    sequence_write: Option<&'static str>,
}

fn digits(alias: &str) -> String {
    format!(
        "(SELECT 0 AS n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) {alias}"
    )
}

fn cross_join_million() -> String {
    let parts: Vec<String> = ["a", "b", "c", "d", "e", "f"].iter().map(|a| digits(a)).collect();
    format!(
        "SELECT a.n + b.n * 10 + c.n * 100 + d.n * 1000 + e.n * 10000 + f.n * 100000 AS v FROM {}",
        parts.join(", ")
    )
}

fn target_from_env(var: &str) -> Option<Target> {
    let url = match std::env::var(var) {
        Ok(u) if !u.is_empty() => u,
        _ => {
            eprintln!("BLOCKED: {var} is not set; start servers with scripts/test-db.sh up");
            return None;
        }
    };
    let parsed = parse_connection_url(&url).expect("valid test URL");
    let (schema, sleep_sql, big_query, sequence_write) = match parsed.profile.driver {
        Driver::Postgres => (
            "public".to_string(),
            "SELECT pg_sleep(30)",
            "SELECT g AS v FROM generate_series(1, 1000000) g".to_string(),
            Some("SELECT nextval('tpm_it_seq')"),
        ),
        // MySQL's SLEEP() returns 1 when killed instead of raising an error, so use a
        // long-running scan, which fails with ER_QUERY_INTERRUPTED when cancelled.
        Driver::Mysql => (
            parsed.profile.database.clone(),
            "SELECT count(*) FROM (SELECT 1 FROM information_schema.COLUMNS a, information_schema.COLUMNS b, information_schema.COLUMNS c) x",
            cross_join_million(),
            None,
        ),
        Driver::Mssql => (
            "dbo".to_string(),
            "WAITFOR DELAY '00:00:30'",
            "SELECT TOP 1000000 ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS v \
             FROM sys.all_objects a CROSS JOIN sys.all_objects b CROSS JOIN sys.all_objects c"
                .to_string(),
            None,
        ),
        _ => (parsed.profile.database.clone(), "SELECT SLEEP(30)", cross_join_million(), None),
    };
    Some(Target { profile: parsed.profile, password: parsed.password, schema, sleep_sql, big_query, sequence_write })
}

fn sqlite_target(dir: &tempfile::TempDir) -> Target {
    let path = dir.path().join("it.sqlite");
    adapters::sqlite::create_database_file(path.to_str().unwrap()).unwrap();
    let mut profile = ConnectionProfile::new("sqlite-it", Driver::Sqlite);
    profile.file_path = Some(path.to_string_lossy().into_owned());
    Target {
        profile,
        password: None,
        schema: "main".into(),
        // A CPU-bound query long enough to cancel.
        sleep_sql: "WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM r) SELECT count(*) FROM r",
        big_query:
            "WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM r WHERE i < 1000000) SELECT i AS v FROM r"
                .into(),
        sequence_write: None,
    }
}

fn ddl(driver: Driver) -> Vec<&'static str> {
    match driver {
        Driver::Duckdb => vec![
            "DROP TABLE IF EXISTS tpm_it_items",
            "DROP TABLE IF EXISTS tpm_it_owners",
            "DROP SEQUENCE IF EXISTS tpm_it_seq",
            "CREATE SEQUENCE tpm_it_seq",
            "CREATE TABLE tpm_it_owners (id integer PRIMARY KEY, name varchar NOT NULL)",
            "CREATE TABLE tpm_it_items (id integer PRIMARY KEY DEFAULT nextval('tpm_it_seq'), owner_id integer REFERENCES tpm_it_owners(id), \
             name varchar NOT NULL UNIQUE, price decimal(10,2), data blob, tags varchar, created timestamp DEFAULT current_timestamp)",
            "CREATE INDEX tpm_it_items_price ON tpm_it_items(price)",
        ],
        Driver::Postgres => vec![
            "DROP TABLE IF EXISTS tpm_it_items",
            "DROP TABLE IF EXISTS tpm_it_owners",
            "DROP SEQUENCE IF EXISTS tpm_it_seq",
            "CREATE SEQUENCE tpm_it_seq",
            "CREATE TABLE tpm_it_owners (id integer PRIMARY KEY, name text NOT NULL)",
            "CREATE TABLE tpm_it_items (id serial PRIMARY KEY, owner_id integer REFERENCES tpm_it_owners(id), \
             name text NOT NULL UNIQUE, price numeric(10,2), data bytea, tags jsonb, created timestamptz DEFAULT now())",
            "CREATE INDEX tpm_it_items_price ON tpm_it_items(price)",
        ],
        Driver::Mysql | Driver::Mariadb | Driver::Redis => vec![
            "DROP TABLE IF EXISTS tpm_it_items",
            "DROP TABLE IF EXISTS tpm_it_owners",
            "CREATE TABLE tpm_it_owners (id int PRIMARY KEY, name varchar(100) NOT NULL) ENGINE=InnoDB",
            "CREATE TABLE tpm_it_items (id int AUTO_INCREMENT PRIMARY KEY, owner_id int, name varchar(100) NOT NULL UNIQUE, \
             price decimal(10,2), data blob, tags json, created datetime DEFAULT CURRENT_TIMESTAMP, \
             FOREIGN KEY (owner_id) REFERENCES tpm_it_owners(id), INDEX tpm_it_items_price (price)) ENGINE=InnoDB",
        ],
        Driver::Mssql => vec![
            "DROP TABLE IF EXISTS tpm_it_items",
            "DROP TABLE IF EXISTS tpm_it_owners",
            "CREATE TABLE tpm_it_owners (id int PRIMARY KEY, name nvarchar(100) NOT NULL)",
            "CREATE TABLE tpm_it_items (id int IDENTITY PRIMARY KEY, owner_id int REFERENCES tpm_it_owners(id), \
             name nvarchar(100) NOT NULL UNIQUE, price decimal(10,2), data varbinary(max), tags nvarchar(max), \
             created datetime2 DEFAULT sysdatetime())",
            "CREATE INDEX tpm_it_items_price ON tpm_it_items(price)",
        ],
        Driver::Sqlite => vec![
            "DROP TABLE IF EXISTS tpm_it_items",
            "DROP TABLE IF EXISTS tpm_it_owners",
            "CREATE TABLE tpm_it_owners (id integer PRIMARY KEY, name text NOT NULL)",
            "CREATE TABLE tpm_it_items (id integer PRIMARY KEY, owner_id integer REFERENCES tpm_it_owners(id), \
             name text NOT NULL UNIQUE, price numeric, data blob, tags text, created text DEFAULT CURRENT_TIMESTAMP)",
            "CREATE INDEX tpm_it_items_price ON tpm_it_items(price)",
        ],
    }
}

fn blob_literal(driver: Driver) -> &'static str {
    match driver {
        Driver::Postgres => "'\\xdeadbeef'::bytea",
        Driver::Duckdb => "'\\xDE\\xAD\\xBE\\xEF'::BLOB",
        Driver::Mssql => "0xDEADBEEF",
        _ => "X'DEADBEEF'",
    }
}

async fn run(engine: &Engine, session: &str, sql: &str) -> tpm_core::engine::ScriptResult {
    let r = engine
        .run_script(session, sql, RunOptions { confirmed: true, ..Default::default() }, None)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e:?}"));
    if let Some(e) = r.statements.iter().find_map(|s| s.error.as_ref()) {
        panic!("{sql}: {e:?}");
    }
    r
}

fn text(c: &Cell) -> &str {
    c.as_text().unwrap_or("<null>")
}

async fn exercise(t: Target) {
    let driver = t.profile.driver;
    let mut profile = t.profile.clone();
    profile.safety_mode = SafetyMode::ConfirmDestructive;
    let engine = Arc::new(Engine::new());
    let info =
        engine.open_session(&profile, t.password.as_deref(), None, ConnectOptions::default()).await.expect("connect");
    let sid = info.session_id.clone();
    eprintln!("connected: {} {}", info.server.product, info.server.version);

    // --- fixtures (DROP needs confirmation under ConfirmDestructive) ---
    let script = ddl(driver).join(";\n");
    let err = engine.run_script(&sid, &script, RunOptions::default(), None).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::ConfirmationRequired, "destructive script must need confirmation");
    run(&engine, &sid, &script).await;
    let blob = blob_literal(driver);
    run(
        &engine,
        &sid,
        &format!(
            "INSERT INTO tpm_it_owners (id, name) VALUES (1, 'Ada'), (2, 'Grace');
             INSERT INTO tpm_it_items (owner_id, name, price, data, tags) VALUES
               (1, 'apple', 1.50, {blob}, '{{\"a\": 1}}'), (1, 'banana', 0.25, NULL, NULL),
               (2, 'cherry', 12.00, NULL, NULL), (NULL, 'it''s; tricky', NULL, NULL, NULL)"
        ),
    )
    .await;

    // --- the default schema follows the sidebar (query tabs) ---
    if driver != Driver::Sqlite {
        let create = match driver {
            Driver::Mysql | Driver::Mariadb => "CREATE DATABASE IF NOT EXISTS tpm_it_alt",
            _ => "CREATE SCHEMA IF NOT EXISTS tpm_it_alt",
        };
        run(&engine, &sid, create).await;
        run(&engine, &sid, "CREATE TABLE IF NOT EXISTS tpm_it_alt.tpm_it_marker (v INT)").await;
        engine.set_default_schema(&sid, "tpm_it_alt").await.expect("switch schema");
        run(&engine, &sid, "SELECT COUNT(*) FROM tpm_it_marker").await;
        engine.set_default_schema(&sid, &t.schema).await.expect("switch back");
        let r = engine.run_script(&sid, "SELECT COUNT(*) FROM tpm_it_marker", RunOptions::default(), None).await;
        assert!(
            r.map(|r| r.statements[0].error.is_some()).unwrap_or(true),
            "unqualified name must resolve in {}",
            t.schema
        );
        let drop = match driver {
            Driver::Mysql | Driver::Mariadb => "DROP DATABASE tpm_it_alt",
            _ => "DROP SCHEMA tpm_it_alt CASCADE",
        };
        run(&engine, &sid, drop).await;
    }

    // --- schema discovery ---
    let schemas = engine.list_schemas(&sid).await.unwrap();
    assert!(schemas.contains(&t.schema), "{schemas:?}");
    let objects = engine.list_objects(&sid, &t.schema).await.unwrap();
    assert!(objects.iter().any(|o| o.name == "tpm_it_items" && o.kind == ObjectKind::Table));
    let st = engine.table_structure(&sid, &t.schema, "tpm_it_items", true).await.unwrap();
    assert_eq!(st.columns.len(), 7);
    assert_eq!(st.primary_key().len(), 1);
    assert_eq!(st.primary_key()[0].name, "id");
    assert!(st.columns[0].auto_increment, "id should be auto-increment: {:?}", st.columns[0]);
    assert!(!st.column("name").unwrap().nullable);
    assert!(st.indexes.iter().any(|i| i.columns == vec!["price".to_string()]), "{:?}", st.indexes);
    assert_eq!(st.foreign_keys.len(), 1, "{:?}", st.foreign_keys);
    assert_eq!(st.foreign_keys[0].ref_table, "tpm_it_owners");
    let def = engine.object_definition(&sid, &t.schema, "tpm_it_items", ObjectKind::Table).await.unwrap();
    assert!(def.to_lowercase().contains("create table"), "{def}");

    // --- ad-hoc SQL, multi-statement, values as text, binary ---
    let r = run(&engine, &sid, "SELECT id, name, price, data FROM tpm_it_items ORDER BY id; SELECT 1 + 1 AS two").await;
    assert_eq!(r.statements.len(), 2);
    let rows = r.statements[0].rows.as_ref().unwrap();
    assert_eq!(rows.len(), 4);
    assert_eq!(text(&rows[0][1]), "apple");
    assert_eq!(text(&rows[0][2]), "1.50".trim_end_matches(if driver == Driver::Sqlite { "0" } else { "" }));
    assert_eq!(text(&rows[3][1]), "it's; tricky");
    assert_eq!(rows[1][3], Cell::Null);
    match &rows[0][3] {
        Cell::Bytes(b) => assert_eq!(b, &vec![0xde, 0xad, 0xbe, 0xef]),
        Cell::Text(t) if driver == Driver::Duckdb => {
            assert_eq!(t, "\\xDE\\xAD\\xBE\\xEF", "DuckDB's own BLOB text form")
        }
        Cell::Text(t) => assert_eq!(t, "\\xdeadbeef", "PostgreSQL text protocol renders bytea as hex"),
        Cell::Null => panic!("blob missing"),
        other => panic!("unexpected placeholder for a blob in a query result: {other:?}"),
    }
    assert_eq!(text(&r.statements[1].rows.as_ref().unwrap()[0][0]), "2");

    // --- errors: position mapping and stop-on-error ---
    let r = engine
        .run_script(&sid, "SELECT 1;\nSELEC oops", RunOptions { confirmed: true, ..Default::default() }, None)
        .await
        .unwrap();
    assert_eq!(r.statements.len(), 2);
    let e = r.statements[1].error.as_ref().expect("syntax error");
    assert_eq!(e.kind, ErrorKind::Database);
    if driver == Driver::Postgres {
        assert_eq!(e.position, Some(10), "position maps into the full script");
    }

    // --- constraint violation ---
    let r = engine
        .run_script(&sid, "INSERT INTO tpm_it_items (name) VALUES ('apple')", RunOptions::default(), None)
        .await
        .unwrap();
    assert_eq!(r.statements[0].error.as_ref().unwrap().kind, ErrorKind::Constraint);

    // --- browse: filter, sort, pagination ---
    let req = BrowseRequest {
        schema: t.schema.clone(),
        table: "tpm_it_items".into(),
        filter: Some(FilterNode::Group {
            logic: Logic::Or,
            negate: false,
            children: vec![
                FilterNode::Condition {
                    column: "price".into(),
                    op: FilterOp::Gte,
                    value: Some("1".into()),
                    value2: None,
                    values: vec![],
                    enabled: true,
                },
                FilterNode::Condition {
                    column: "name".into(),
                    op: FilterOp::Contains,
                    value: Some("; TRICK".into()),
                    value2: None,
                    values: vec![],
                    enabled: true,
                },
            ],
        }),
        sort: vec![SortSpec { column: "name".into(), descending: true }],
        limit: 2,
        offset: 0,
        ..Default::default()
    };
    let page = engine.browse(&sid, &req).await.unwrap();
    let names: Vec<&str> = page.rows.iter().map(|r| text(&r[2])).collect();
    assert_eq!(names, ["it's; tricky", "cherry"]);
    assert!(page.has_more);
    let page2 = engine.browse(&sid, &BrowseRequest { offset: 2, ..req.clone() }).await.unwrap();
    assert_eq!(page2.rows.len(), 1);
    assert!(!page2.has_more);
    assert_eq!(engine.count_rows(&sid, &t.schema, "tpm_it_items", req.filter.as_ref()).await.unwrap(), 3);
    // Injection attempt through a filter value is just data.
    let evil = BrowseRequest {
        filter: Some(FilterNode::Condition {
            column: "name".into(),
            op: FilterOp::Eq,
            value: Some("x' OR '1'='1".into()),
            value2: None,
            values: vec![],
            enabled: true,
        }),
        ..req.clone()
    };
    assert!(engine.browse(&sid, &evil).await.unwrap().rows.is_empty());

    // --- pending changes: update + insert + delete in one transaction ---
    let apple = engine
        .browse(
            &sid,
            &BrowseRequest {
                filter: Some(FilterNode::Condition {
                    column: "name".into(),
                    op: FilterOp::Eq,
                    value: Some("apple".into()),
                    value2: None,
                    values: vec![],
                    enabled: true,
                }),
                limit: 10,
                ..req.clone()
            },
        )
        .await
        .unwrap();
    let apple_id = text(&apple.rows[0][0]).to_string();
    let apple_price = apple.rows[0][3].as_text().map(str::to_string);
    let key = |id: &str| vec![ColumnValue { column: "id".into(), value: Some(id.into()) }];
    let set = ChangeSet {
        schema: t.schema.clone(),
        table: "tpm_it_items".into(),
        check_conflicts: true,
        changes: vec![
            RowChange::Update {
                key: key(&apple_id),
                edits: vec![ColumnEdit {
                    column: "price".into(),
                    value: EditValue::Value { value: Some("2.75".into()) },
                    original: Some(apple_price.clone()),
                }],
            },
            RowChange::Insert {
                values: vec![
                    ColumnEdit { column: "id".into(), value: EditValue::Default, original: None },
                    ColumnEdit {
                        column: "name".into(),
                        value: EditValue::Value { value: Some("date".into()) },
                        original: None,
                    },
                    ColumnEdit {
                        column: "owner_id".into(),
                        value: EditValue::Value { value: Some("2".into()) },
                        original: None,
                    },
                ],
            },
        ],
    };
    let preview = engine.preview_changes(&sid, &set).await.unwrap();
    assert!(preview.sql.contains("'2.75'"), "{}", preview.sql);
    assert!(engine.apply_changes(&sid, &set, false).await.is_err(), "commit requires review confirmation");
    assert_eq!(engine.apply_changes(&sid, &set, true).await.unwrap(), vec![1, 1]);
    let r = run(&engine, &sid, "SELECT price FROM tpm_it_items WHERE name = 'apple'").await;
    assert!(text(&r.statements[0].rows.as_ref().unwrap()[0][0]).starts_with("2.75"));

    // --- optimistic concurrency: stale original value -> conflict, nothing committed ---
    let stale = ChangeSet {
        schema: t.schema.clone(),
        table: "tpm_it_items".into(),
        check_conflicts: true,
        changes: vec![
            RowChange::Insert {
                values: vec![ColumnEdit {
                    column: "name".into(),
                    value: EditValue::Value { value: Some("should-roll-back".into()) },
                    original: None,
                }],
            },
            RowChange::Update {
                key: key(&apple_id),
                edits: vec![ColumnEdit {
                    column: "price".into(),
                    value: EditValue::Value { value: Some("9.99".into()) },
                    original: Some(apple_price),
                }],
            },
        ],
    };
    let err = engine.apply_changes(&sid, &stale, true).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Conflict, "{err:?}");
    let r = run(&engine, &sid, "SELECT count(*) FROM tpm_it_items WHERE name = 'should-roll-back'").await;
    assert_eq!(text(&r.statements[0].rows.as_ref().unwrap()[0][0]), "0", "transaction must roll back");

    // --- constraint failure during commit rolls back the whole set ---
    let bad = ChangeSet {
        schema: t.schema.clone(),
        table: "tpm_it_items".into(),
        check_conflicts: false,
        changes: vec![
            RowChange::Delete { key: key(&apple_id) },
            RowChange::Insert {
                values: vec![ColumnEdit {
                    column: "name".into(),
                    value: EditValue::Value { value: Some("banana".into()) },
                    original: None,
                }],
            },
        ],
    };
    let err = engine.apply_changes(&sid, &bad, true).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Constraint);
    let r = run(&engine, &sid, "SELECT count(*) FROM tpm_it_items WHERE name = 'apple'").await;
    assert_eq!(text(&r.statements[0].rows.as_ref().unwrap()[0][0]), "1", "delete must be rolled back");

    // --- large result: capped, paged, and the server query stopped early ---
    let t0 = Instant::now();
    let r = engine
        .run_script(&sid, &t.big_query, RunOptions { max_rows: Some(100_000), ..Default::default() }, None)
        .await
        .unwrap();
    let s = &r.statements[0];
    assert!(s.error.is_none(), "{:?}", s.error);
    assert_eq!(s.total_rows, Some(100_000));
    assert!(s.truncated);
    assert_eq!(s.rows.as_ref().unwrap().len(), tpm_core::engine::FIRST_PAGE_ROWS);
    let page = engine.fetch_rows(s.result_id.as_ref().unwrap(), 99_990, 50).unwrap();
    assert_eq!(page.len(), 10);
    eprintln!("1M-row query capped at 100k in {:?}", t0.elapsed());
    engine.release_results(&[s.result_id.clone().unwrap()]);
    assert!(engine.fetch_rows(s.result_id.as_ref().unwrap(), 0, 1).is_err());

    // The session is still usable after early termination.
    run(&engine, &sid, "SELECT 1").await;

    // --- cancellation ---
    let task_id = "cancel-me".to_string();
    let e2 = engine.clone();
    let sid2 = sid.clone();
    let sleep_sql = t.sleep_sql.to_string();
    let handle = tokio::spawn(async move {
        e2.run_script(&sid2, &sleep_sql, RunOptions { task_id: Some("cancel-me".into()), ..Default::default() }, None)
            .await
    });
    tokio::time::sleep(Duration::from_millis(700)).await;
    let t0 = Instant::now();
    assert!(engine.cancel_task(&task_id).await.unwrap());
    let r = handle.await.unwrap().unwrap();
    assert!(t0.elapsed() < Duration::from_secs(5), "cancel took {:?}", t0.elapsed());
    assert!(r.cancelled);
    assert_eq!(r.statements[0].error.as_ref().unwrap().kind, ErrorKind::Cancelled, "{:?}", r.statements[0].error);
    run(&engine, &sid, "SELECT 1").await;

    // --- timeout ---
    let t0 = Instant::now();
    let r = engine
        .run_script(&sid, t.sleep_sql, RunOptions { timeout_secs: Some(1), ..Default::default() }, None)
        .await
        .unwrap();
    assert_eq!(r.statements[0].error.as_ref().unwrap().kind, ErrorKind::Timeout);
    assert!(t0.elapsed() < Duration::from_secs(6));
    run(&engine, &sid, "SELECT 1").await;

    // --- explain ---
    if info.capabilities.explain {
        let plan =
            engine.explain(&sid, "SELECT * FROM tpm_it_items WHERE price > 1", false, false, None).await.unwrap();
        assert!(!plan.raw.is_empty());
        if driver == Driver::Postgres {
            let v: serde_json::Value = serde_json::from_str(&plan.raw).unwrap();
            assert!(v[0]["Plan"]["Node Type"].is_string());
        }
    } else {
        assert_eq!(
            engine.explain(&sid, "SELECT 1", false, false, None).await.unwrap_err().kind,
            ErrorKind::Unsupported
        );
    }

    // --- read-only mode: policy layer and database-level enforcement ---
    let mut ro = t.profile.clone();
    ro.safety_mode = SafetyMode::ReadOnly;
    let ro_info = engine.open_session(&ro, t.password.as_deref(), None, ConnectOptions::default()).await.unwrap();
    let err = engine
        .run_script(
            &ro_info.session_id,
            "DELETE FROM tpm_it_items WHERE id = 1",
            RunOptions { confirmed: true, ..Default::default() },
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::PolicyViolation);
    run(&engine, &ro_info.session_id, "SELECT count(*) FROM tpm_it_items").await;
    if let Some(sql) = t.sequence_write {
        // Classified as a read, but the server's read-only transaction refuses it.
        let r = engine.run_script(&ro_info.session_id, sql, RunOptions::default(), None).await.unwrap();
        assert!(r.statements[0].error.is_some(), "read-only must be enforced by the server");
    }
    let mut raw = adapters::connect(&ro, t.password.as_deref(), &ConnectOptions::default()).await.unwrap();
    let res = raw.execute("INSERT INTO tpm_it_owners (id, name) VALUES (99, 'nope')", 10).await;
    assert!(res.is_err(), "database-level read-only must reject writes even without the policy layer");
    raw.close().await;
    assert!(engine.apply_changes(&ro_info.session_id, &set, true).await.is_err());
    engine.close_session(&ro_info.session_id).await;

    // --- connection loss is reported as a network error ---
    if !driver.is_file_based() {
        let killer =
            engine.open_session(&profile, t.password.as_deref(), None, ConnectOptions::default()).await.unwrap();
        let victim =
            engine.open_session(&profile, t.password.as_deref(), None, ConnectOptions::default()).await.unwrap();
        let pid_sql = if driver == Driver::Postgres { "SELECT pg_backend_pid()" } else { "SELECT CONNECTION_ID()" };
        let r = run(&engine, &victim.session_id, pid_sql).await;
        let pid = text(&r.statements[0].rows.as_ref().unwrap()[0][0]).to_string();
        let kill = if driver == Driver::Postgres {
            format!("SELECT pg_terminate_backend({pid})")
        } else {
            format!("KILL {pid}")
        };
        run(&engine, &killer.session_id, &kill).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        let r = engine.run_script(&victim.session_id, "SELECT 1", RunOptions::default(), None).await.unwrap();
        let kind = r.statements[0].error.as_ref().map(|e| e.kind);
        assert!(matches!(kind, Some(ErrorKind::Network | ErrorKind::Database)), "{:?}", r.statements[0].error);
        engine.reconnect(&victim.session_id, t.password.as_deref(), None).await.unwrap();
        run(&engine, &victim.session_id, "SELECT 1").await;
        engine.close_session(&killer.session_id).await;
        engine.close_session(&victim.session_id).await;
    }

    transfer_roundtrip(&engine, &sid, &t.schema, driver).await;

    // --- dashboard widgets: read-only session, one statement, dates as validated literals ---
    let mut ro_profile = t.profile.clone();
    ro_profile.safety_mode = SafetyMode::ReadOnly;
    let dash = engine.open_session(&ro_profile, t.password.as_deref(), None, ConnectOptions::default()).await.unwrap();
    let mut params = std::collections::HashMap::new();
    params.insert("from".to_string(), "2000-01-01".to_string());
    let rs = engine
        .run_widget(
            &dash.session_id,
            "SELECT count(*) AS n FROM tpm_it_items WHERE {{from}} < '2100-01-01'",
            &params,
            10,
            100,
        )
        .await
        .unwrap();
    assert_eq!(text(&rs.rows[0][0]), "5");
    let err = engine
        .run_widget(&dash.session_id, "DELETE FROM tpm_it_items", &Default::default(), 10, 100)
        .await
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::PolicyViolation);
    assert!(engine.run_widget(&dash.session_id, "SELECT 1; SELECT 2", &Default::default(), 10, 100).await.is_err());
    let err = engine.run_widget(&dash.session_id, t.sleep_sql, &Default::default(), 1, 100).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Timeout);
    engine.close_session(&dash.session_id).await;

    origins(&engine, &sid, driver).await;
    edit_results(&engine, &sid, &profile, t.password.as_deref(), driver).await;
    lazy_values(&engine, &sid, &t.schema, driver).await;
    fk_round_trip(&engine, &sid, &t.schema, driver).await;
    restore_points(&engine, &sid, &t.schema, driver, &profile, t.password.as_deref()).await;
    restore_point_edges(&engine, &sid, driver).await;
    restore_point_restores(&engine, &sid, &t.schema, driver).await;
    safety_fixes(&engine, &sid, driver).await;
    result_types(&engine, &sid, driver, &profile, t.password.as_deref()).await;
    text_equality(&engine, &sid, &t.schema, driver).await;
    copied_inserts_round_trip(&engine, &sid, driver).await;
    query_parameters(&engine, &sid, driver).await;
    bound_results_match_plain_runs(&engine, &sid, driver).await;

    // --- cleanup ---
    run(&engine, &sid, "DROP TABLE tpm_it_items; DROP TABLE tpm_it_owners").await;
    engine.close_all().await;
}

/// Restore points: planned before anything runs, captured around the statement, restored by review.
async fn restore_points(
    engine: &Arc<Engine>,
    sid: &str,
    schema: &str,
    driver: Driver,
    profile: &ConnectionProfile,
    password: Option<&str>,
) {
    use tpm_core::restore::{RestoreStatus, RestoreStore};
    let store = Arc::new(tpm_core::storage::Storage::open_in_memory().unwrap());
    engine.set_restore_store(store.clone());
    run(engine, sid, "DROP TABLE IF EXISTS tpm_it_rp").await;
    run(engine, sid, "DROP TABLE IF EXISTS tpm_it_rp_nokey").await;
    run(engine, sid, "CREATE TABLE tpm_it_rp (id integer PRIMARY KEY, status varchar(20), qty integer)").await;
    run(engine, sid, "INSERT INTO tpm_it_rp VALUES (1, 'paid', 5), (2, 'paid', 7), (3, 'new', 1)").await;
    run(engine, sid, "CREATE TABLE tpm_it_rp_nokey (a integer)").await;

    // Planning: one confirmation names every statement that can't keep a restore point.
    let opts = |confirmed| RunOptions { confirmed, ..Default::default() };
    let err = engine
        .run_script(
            sid,
            "UPDATE tpm_it_rp_nokey SET a = 1; DELETE FROM tpm_it_rp ORDER BY id LIMIT 1",
            opts(false),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::ConfirmationRequired, "{driver:?}");
    let detail = err.detail.clone().unwrap_or_default();
    // Statement 1 is destructive (no WHERE) *and* can't keep a restore point; one confirmation names both.
    assert!(detail.contains("UPDATE without a WHERE clause changes every row"), "{driver:?}: {detail}");
    assert!(
        detail.contains("Statement 1: can't keep a restore point (the table has no primary key)"),
        "{driver:?}: {detail}"
    );
    assert!(detail.contains("Statement 2: can't keep a restore point ("), "{driver:?}: {detail}");
    if matches!(driver, Driver::Mysql | Driver::Mariadb) {
        assert!(
            detail.contains("Statement 2: can't keep a restore point (uses ORDER BY or LIMIT)"),
            "{driver:?}: {detail}"
        );
    }
    // Over the row limit.
    let small = RunOptions { confirmed: false, restore_max_rows: Some(2), ..Default::default() };
    let err = engine.run_script(sid, "UPDATE tpm_it_rp SET qty = 0 WHERE qty > 0", small, None).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::ConfirmationRequired, "{driver:?}");
    assert!(err.detail.unwrap_or_default().contains("affects more than 2 rows"), "{driver:?}");
    // A capturable statement within the limits needs no confirmation.
    engine.run_script(sid, "UPDATE tpm_it_rp SET qty = qty WHERE id = 3", opts(false), None).await.unwrap();
    // Confirming runs it anyway.
    let r = engine.run_script(sid, "UPDATE tpm_it_rp_nokey SET a = 1", opts(true), None).await.unwrap();
    assert!(r.statements[0].error.is_none(), "{driver:?}");
    // A connection with restore points turned off keeps none, and says nothing about them.
    if driver != Driver::Sqlite && driver != Driver::Duckdb {
        let off = ConnectionProfile { restore_points: false, ..profile.clone() };
        let other = engine.open_session(&off, password, None, ConnectOptions::default()).await.expect("connect");
        let r = engine
            .run_script(&other.session_id, "UPDATE tpm_it_rp SET qty = qty WHERE id = 3", opts(true), None)
            .await
            .unwrap();
        assert!(r.statements[0].restore.is_none(), "{driver:?}");
        let r = engine
            .run_script(&other.session_id, "UPDATE tpm_it_rp_nokey SET a = 1", opts(false), None)
            .await
            .unwrap_err();
        assert!(!r.detail.unwrap_or_default().contains("restore point"), "{driver:?}");
        engine.close_session(&other.session_id).await;
    }
    // ... and its message says why there is no restore point.
    let note = r.statements[0].restore.clone().expect("note");
    assert_eq!((note.point_id, note.reason.as_deref()), (None, Some("the table has no primary key")), "{driver:?}");

    // UPDATE: captured before → after, kept, and the note says so.
    let r = engine
        .run_script(sid, "UPDATE tpm_it_rp SET status = 'cancelled' WHERE status = 'paid'", opts(true), None)
        .await
        .unwrap();
    assert!(r.statements[0].error.is_none(), "{driver:?}: {:?}", r.statements[0].error);
    let id = r.statements[0].restore.clone().and_then(|n| n.point_id).expect("saved");
    let p = store.get(&id).unwrap();
    assert_eq!((p.row_count, p.data.before.len()), (2, 2), "{driver:?}");
    assert_eq!((p.schema.as_str(), p.table.as_str()), (schema, "tpm_it_rp"), "{driver:?}");
    assert_eq!(p.data.columns, vec!["id".to_string(), "status".to_string(), "qty".to_string()]);
    assert_eq!(p.data.key_columns, vec!["id".to_string()]);
    assert!(p.data.before.iter().all(|r| r[1].as_deref() == Some("paid")), "{driver:?}: {:?}", p.data.before);
    assert!(p.data.after.iter().all(|r| r.as_ref().unwrap()[1].as_deref() == Some("cancelled")), "{driver:?}");
    assert_eq!(p.status, RestoreStatus::Kept);
    assert_eq!(p.statement, "UPDATE tpm_it_rp SET status = 'cancelled' WHERE status = 'paid'");
    // The size counts every value kept: the rows before and after.
    let len = |r: &Vec<Option<String>>| r.iter().map(|v| v.as_ref().map_or(0, |t| t.len() as u64)).sum::<u64>();
    let expected = p.data.before.iter().map(len).sum::<u64>() + p.data.after.iter().flatten().map(len).sum::<u64>();
    assert_eq!(p.bytes, expected, "{driver:?}");
    // DELETE: before rows only.
    let r = engine.run_script(sid, "DELETE FROM tpm_it_rp WHERE id = 3", opts(true), None).await.unwrap();
    let p = store.get(r.statements[0].restore.as_ref().unwrap().point_id.as_ref().unwrap()).unwrap();
    assert_eq!((p.data.before.len(), p.data.after.len()), (1, 0), "{driver:?}");
    assert_eq!(p.data.before[0][0].as_deref(), Some("3"));
    // Over the size limit: the statement runs, and its message says why there is no restore point.
    let tiny = RunOptions { confirmed: true, restore_max_mb: Some(0), ..Default::default() };
    let r = engine.run_script(sid, "UPDATE tpm_it_rp SET qty = qty WHERE id = 1", tiny, None).await.unwrap();
    let note = r.statements[0].restore.clone().expect("note");
    assert!(note.point_id.is_none() && note.reason.unwrap_or_default().starts_with("more than"), "{driver:?}");
    // Inside the user's transaction: pending; ROLLBACK deletes it, COMMIT keeps it.
    run(engine, sid, "BEGIN").await;
    let r = engine.run_script(sid, "UPDATE tpm_it_rp SET qty = 99 WHERE id = 1", opts(true), None).await.unwrap();
    if driver == Driver::Duckdb {
        // No savepoints on DuckDB: nothing is read inside a transaction, and the message says so.
        let reason = r.statements[0].restore.as_ref().and_then(|n| n.reason.clone());
        assert_eq!(reason.as_deref(), Some("inside a transaction on DuckDB"));
        run(engine, sid, "ROLLBACK").await;
    } else {
        let pend = r.statements[0].restore.as_ref().unwrap().point_id.clone().unwrap();
        assert_eq!(store.get(&pend).unwrap().status, RestoreStatus::Pending, "{driver:?}");
        run(engine, sid, "ROLLBACK").await;
        assert!(store.get(&pend).is_err(), "rolled back: no restore point ({driver:?})");
        run(engine, sid, "BEGIN").await;
        let r = engine.run_script(sid, "UPDATE tpm_it_rp SET qty = 98 WHERE id = 1", opts(true), None).await.unwrap();
        let kept = r.statements[0].restore.as_ref().unwrap().point_id.clone().unwrap();
        run(engine, sid, "COMMIT").await;
        assert_eq!(store.get(&kept).unwrap().status, RestoreStatus::Kept, "{driver:?}");
    }
    // PostgreSQL: after an error the transaction is aborted, and its COMMIT rolls back.
    if driver == Driver::Postgres {
        run(engine, sid, "BEGIN").await;
        let r = engine.run_script(sid, "UPDATE tpm_it_rp SET qty = 97 WHERE id = 1", opts(true), None).await.unwrap();
        let doomed = r.statements[0].restore.as_ref().unwrap().point_id.clone().unwrap();
        let r = engine.run_script(sid, "SELECT 1/0", opts(true), None).await.unwrap();
        assert!(r.statements[0].error.is_some());
        run(engine, sid, "COMMIT").await;
        assert!(store.get(&doomed).is_err(), "the COMMIT rolled back: no restore point");
    }
    // A capture SELECT that fails at run time: a role that may count rows (SELECT on `id`) and
    // update, but not read every column. Planning succeeds; the capture SELECT is refused; the
    // UPDATE still runs, the note says why, and the user's transaction survives.
    if driver == Driver::Postgres {
        // Left behind by an earlier failed run?
        run(engine, sid, "DO $$ BEGIN IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'tpm_it_limited') THEN EXECUTE 'DROP OWNED BY tpm_it_limited'; END IF; END $$").await;
        run(engine, sid, "DROP ROLE IF EXISTS tpm_it_limited").await;
        run(engine, sid, "CREATE ROLE tpm_it_limited").await;
        run(engine, sid, &format!("GRANT USAGE ON SCHEMA \"{schema}\" TO tpm_it_limited")).await;
        run(engine, sid, "GRANT SELECT (id), UPDATE ON tpm_it_rp TO tpm_it_limited").await;
        run(engine, sid, "BEGIN").await;
        run(engine, sid, "SET LOCAL ROLE tpm_it_limited").await;
        let r = engine.run_script(sid, "UPDATE tpm_it_rp SET qty = 1 WHERE id = 1", opts(true), None).await.unwrap();
        assert!(r.statements[0].error.is_none(), "the statement still runs: {:?}", r.statements[0].error);
        let note = r.statements[0].restore.clone().expect("note");
        assert!(note.point_id.is_none());
        assert!(note.reason.clone().unwrap_or_default().starts_with("could not read the rows"), "{note:?}");
        run(engine, sid, "SELECT 1").await; // the transaction is still usable
        run(engine, sid, "ROLLBACK").await;
        run(engine, sid, "DROP OWNED BY tpm_it_limited").await;
        run(engine, sid, "DROP ROLE tpm_it_limited").await;
    }
    // DROP COLUMN, TRUNCATE and DROP TABLE capture rows (and the definition).
    let r = engine.run_script(sid, "ALTER TABLE tpm_it_rp DROP COLUMN qty", opts(true), None).await.unwrap();
    assert!(r.statements[0].error.is_none(), "{driver:?}: {:?}", r.statements[0].error);
    let dc = store.get(r.statements[0].restore.as_ref().unwrap().point_id.as_ref().unwrap()).unwrap();
    assert_eq!(dc.data.columns, vec!["id".to_string(), "qty".to_string()], "{driver:?}");
    assert_eq!(dc.data.before.len(), 2);
    assert!(dc.data.column_type.is_some());
    let r = engine.run_script(sid, "TRUNCATE TABLE tpm_it_rp", opts(true), None).await.unwrap();
    if r.statements[0].error.is_none() {
        let tp = store.get(r.statements[0].restore.as_ref().unwrap().point_id.as_ref().unwrap()).unwrap();
        assert_eq!(tp.row_count, 2, "{driver:?}");
    } else {
        // SQLite has no TRUNCATE: the statement fails and no restore point is kept.
        assert_eq!(driver, Driver::Sqlite);
        assert!(r.statements[0].restore.as_ref().and_then(|n| n.point_id.clone()).is_none());
    }
    let r = engine.run_script(sid, "DROP TABLE tpm_it_rp", opts(true), None).await.unwrap();
    let dt = store.get(r.statements[0].restore.as_ref().unwrap().point_id.as_ref().unwrap()).unwrap();
    assert!(dt.data.ddl.as_deref().unwrap_or("").to_ascii_uppercase().contains("CREATE"), "{driver:?}");
    run(engine, sid, "CREATE TABLE tpm_it_rp (id integer PRIMARY KEY, status varchar(20), qty integer)").await;
    run(engine, sid, "DROP TABLE tpm_it_rp_nokey").await;

    // Restoring chosen rows: only those change.
    run(engine, sid, "INSERT INTO tpm_it_rp VALUES (1, 'paid', 5), (2, 'paid', 7)").await;
    let r = engine.run_script(sid, "UPDATE tpm_it_rp SET status = 'x', qty = 0", opts(true), None).await.unwrap();
    let pid = r.statements[0].restore.as_ref().unwrap().point_id.clone().unwrap();
    let p = store.get(&pid).unwrap();
    let idx = |id: &str| p.data.before.iter().position(|r| r[0].as_deref() == Some(id)).unwrap();
    let preview = engine.preview_restore(sid, &pid, Some(vec![idx("2")])).await.unwrap();
    assert_eq!(preview.statement_count, 1, "{driver:?}: {}", preview.sql);
    assert!(engine.apply_restore(sid, &pid, Some(vec![idx("2")]), false).await.is_err(), "needs the review");
    engine.apply_restore(sid, &pid, Some(vec![idx("2")]), true).await.unwrap();
    let rows =
        run(engine, sid, "SELECT id, status, qty FROM tpm_it_rp ORDER BY id").await.statements[0].rows.clone().unwrap();
    assert_eq!(text(&rows[0][1]), "x", "row 1 untouched ({driver:?})");
    assert_eq!((text(&rows[1][1]), text(&rows[1][2])), ("paid", "7"), "{driver:?}");
    assert_eq!(store.get(&pid).unwrap().status, RestoreStatus::Restored);
    // Someone changed row 1 since: nothing is written.
    run(engine, sid, "UPDATE tpm_it_rp SET qty = 42 WHERE id = 1").await;
    let err = engine.apply_restore(sid, &pid, Some(vec![idx("1")]), true).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Conflict, "{driver:?}");
    let said = format!("{} {}", err.message, err.detail.clone().unwrap_or_default()).to_lowercase();
    assert!(said.contains("nothing was restored"), "{driver:?}: {err:?}");
    let rows =
        run(engine, sid, "SELECT status, qty FROM tpm_it_rp WHERE id = 1").await.statements[0].rows.clone().unwrap();
    assert_eq!((text(&rows[0][0]), text(&rows[0][1])), ("x", "42"), "{driver:?}");
    // Rows already back as they were are skipped, so the rest can still be restored (here row 2,
    // restored above, and row 1, now changed back by hand).
    run(engine, sid, "UPDATE tpm_it_rp SET qty = 0 WHERE id = 1").await;
    let preview = engine.preview_restore(sid, &pid, None).await.unwrap();
    assert_eq!(preview.statement_count, 1, "only row 1 ({driver:?}): {}", preview.sql);
    engine.apply_restore(sid, &pid, None, true).await.unwrap();
    let rows =
        run(engine, sid, "SELECT status, qty FROM tpm_it_rp ORDER BY id").await.statements[0].rows.clone().unwrap();
    assert_eq!((text(&rows[0][0]), text(&rows[0][1])), ("paid", "5"), "{driver:?}");
    assert_eq!((text(&rows[1][0]), text(&rows[1][1])), ("paid", "7"), "{driver:?}");
    let err = engine.apply_restore(sid, &pid, None, true).await.unwrap_err();
    assert!(err.message.contains("already"), "{driver:?}: {}", err.message);
    run(engine, sid, "UPDATE tpm_it_rp SET status = 'x', qty = 42 WHERE id = 1").await;
    // A DELETE comes back by re-inserting.
    let r = engine.run_script(sid, "DELETE FROM tpm_it_rp WHERE id = 2", opts(true), None).await.unwrap();
    let did = r.statements[0].restore.as_ref().unwrap().point_id.clone().unwrap();
    engine.apply_restore(sid, &did, None, true).await.unwrap();
    let back = run(engine, sid, "SELECT status FROM tpm_it_rp WHERE id = 2").await;
    assert_eq!(text(&back.statements[0].rows.as_ref().unwrap()[0][0]), "paid", "{driver:?}");
    // A grid commit keeps a restore point; restoring keeps one of its own (an undo of the restore).
    let set = ChangeSet {
        schema: schema.into(),
        table: "tpm_it_rp".into(),
        changes: vec![
            RowChange::Update {
                key: vec![ColumnValue { column: "id".into(), value: Some("2".into()) }],
                edits: vec![ColumnEdit {
                    column: "status".into(),
                    value: EditValue::Value { value: Some("grid".into()) },
                    original: Some(Some("paid".into())),
                }],
            },
            RowChange::Delete { key: vec![ColumnValue { column: "id".into(), value: Some("1".into()) }] },
        ],
        check_conflicts: true,
    };
    engine.apply_changes(sid, &set, true).await.unwrap();
    let conn = engine.session_info(sid).unwrap().connection_id;
    let list = store.list_restore_points(&conn).unwrap();
    let grid = list.iter().find(|g| g.kind == tpm_core::restore::RestoreKind::GridEdit).expect("grid edit point");
    assert_eq!(grid.row_count, 2, "{driver:?}");
    assert!(list.iter().any(|g| g.kind == tpm_core::restore::RestoreKind::Restore), "{driver:?}");
    engine.apply_restore(sid, &grid.id, None, true).await.unwrap();
    let rows =
        run(engine, sid, "SELECT id, status, qty FROM tpm_it_rp ORDER BY id").await.statements[0].rows.clone().unwrap();
    assert_eq!(rows.len(), 2, "{driver:?}");
    assert_eq!((text(&rows[0][1]), text(&rows[0][2])), ("x", "42"), "row 1 re-inserted ({driver:?})");
    assert_eq!(text(&rows[1][1]), "paid", "row 2 put back ({driver:?})");
    // A dropped column comes back with its values, and a dropped table with its rows.
    let r = engine.run_script(sid, "ALTER TABLE tpm_it_rp DROP COLUMN qty", opts(true), None).await.unwrap();
    let cid = r.statements[0].restore.as_ref().unwrap().point_id.clone().unwrap();
    let preview = engine.preview_restore(sid, &cid, None).await.unwrap();
    assert!(preview.sql.contains("ADD COLUMN"), "{driver:?}: {}", preview.sql);
    engine.apply_restore(sid, &cid, None, true).await.unwrap();
    let rows = run(engine, sid, "SELECT qty FROM tpm_it_rp ORDER BY id").await.statements[0].rows.clone().unwrap();
    assert_eq!((text(&rows[0][0]), text(&rows[1][0])), ("42", "7"), "{driver:?}");
    let r = engine.run_script(sid, "DROP TABLE tpm_it_rp", opts(true), None).await.unwrap();
    let tid = r.statements[0].restore.as_ref().unwrap().point_id.clone().unwrap();
    let preview = engine.preview_restore(sid, &tid, None).await.unwrap();
    assert!(preview.sql.to_ascii_uppercase().contains("CREATE"), "{driver:?}: {}", preview.sql);
    engine.apply_restore(sid, &tid, None, true).await.unwrap();
    let rows =
        run(engine, sid, "SELECT id, status, qty FROM tpm_it_rp ORDER BY id").await.statements[0].rows.clone().unwrap();
    assert_eq!(rows.len(), 2, "{driver:?}");
    assert_eq!((text(&rows[1][1]), text(&rows[1][2])), ("paid", "7"), "{driver:?}");
    run(engine, sid, "DROP TABLE tpm_it_rp").await;
}

/// Restore points: transactions the engine did not see begin, names resolved at run time, and
/// planning that can be cancelled.
async fn restore_point_edges(engine: &Arc<Engine>, sid: &str, driver: Driver) {
    use tpm_core::restore::{RestoreStatus, RestoreStore};
    let store = Arc::new(tpm_core::storage::Storage::open_in_memory().unwrap());
    engine.set_restore_store(store.clone());
    let opts = |confirmed| RunOptions { confirmed, ..Default::default() };
    let point = |r: &tpm_core::engine::ScriptResult| {
        r.statements.last().and_then(|s| s.restore.clone()).and_then(|n| n.point_id)
    };
    run(engine, sid, "DROP TABLE IF EXISTS tpm_it_rpe").await;
    run(engine, sid, "CREATE TABLE tpm_it_rpe (id integer PRIMARY KEY, qty integer)").await;
    run(engine, sid, "INSERT INTO tpm_it_rpe VALUES (1, 1), (2, 2), (3, 3)").await;
    let qty = |id: i32| async move {
        let r = run(engine, sid, &format!("SELECT qty FROM tpm_it_rpe WHERE id = {id}")).await;
        text(&r.statements[0].rows.as_ref().unwrap()[0][0]).to_string()
    };

    // A transaction the engine did not see begin: the capture must not commit it.
    let started = match driver {
        Driver::Mysql | Driver::Mariadb => Some("SET autocommit = 0"),
        Driver::Sqlite => Some("SAVEPOINT tpm_it_sp"),
        _ => None,
    };
    if let Some(start) = started {
        run(engine, sid, start).await;
        let r = engine.run_script(sid, "UPDATE tpm_it_rpe SET qty = 9 WHERE id = 1", opts(true), None).await.unwrap();
        assert!(r.statements[0].error.is_none(), "{driver:?}: {:?}", r.statements[0].error);
        let id = point(&r).expect("saved");
        assert_eq!(store.get(&id).unwrap().status, RestoreStatus::Pending, "{driver:?}");
        run(engine, sid, "ROLLBACK").await;
        assert_eq!(qty(1).await, "1", "the user's ROLLBACK undid the change ({driver:?})");
        assert!(store.get(&id).is_err(), "{driver:?}");
        if matches!(driver, Driver::Mysql | Driver::Mariadb) {
            run(engine, sid, "SET autocommit = 1").await;
        }
    }

    // MySQL commits the open transaction at DDL: points made after it are no longer pending.
    if matches!(driver, Driver::Mysql | Driver::Mariadb) {
        run(engine, sid, "BEGIN").await;
        run(engine, sid, "CREATE TABLE tpm_it_rpe_tmp (a integer)").await;
        let r = engine.run_script(sid, "UPDATE tpm_it_rpe SET qty = 8 WHERE id = 2", opts(true), None).await.unwrap();
        let id = point(&r).expect("saved");
        run(engine, sid, "ROLLBACK").await;
        assert_eq!(qty(2).await, "8", "autocommitted after the DDL ({driver:?})");
        assert_eq!(store.get(&id).unwrap().status, RestoreStatus::Kept, "{driver:?}");
        run(engine, sid, "DROP TABLE tpm_it_rpe_tmp").await;
    }

    // Names are matched the way the database matches them.
    if matches!(driver, Driver::Sqlite | Driver::Duckdb) {
        let r = engine.run_script(sid, "UPDATE TPM_IT_RPE SET qty = 7 WHERE id = 3", opts(true), None).await.unwrap();
        let id = point(&r).unwrap_or_else(|| panic!("{driver:?}: {:?}", r.statements[0].restore));
        assert_eq!(store.get(&id).unwrap().table, "tpm_it_rpe");
    }

    // A schema switched earlier in the same script: the point names the table actually changed.
    if driver == Driver::Postgres {
        run(engine, sid, "DROP SCHEMA IF EXISTS tpm_it_s2 CASCADE").await;
        run(engine, sid, "CREATE SCHEMA tpm_it_s2").await;
        run(engine, sid, "CREATE TABLE tpm_it_s2.tpm_it_rpe (id integer PRIMARY KEY, qty integer)").await;
        run(engine, sid, "INSERT INTO tpm_it_s2.tpm_it_rpe VALUES (1, 100)").await;
        let r = engine
            .run_script(
                sid,
                "SET search_path TO tpm_it_s2; DELETE FROM tpm_it_rpe WHERE id = 1; SET search_path TO public",
                opts(true),
                None,
            )
            .await
            .unwrap();
        let id = r.statements[1].restore.as_ref().and_then(|n| n.point_id.clone()).expect("saved");
        let p = store.get(&id).unwrap();
        assert_eq!((p.schema.as_str(), p.data.before[0][1].as_deref()), ("tpm_it_s2", Some("100")));
        run(engine, sid, "DROP SCHEMA tpm_it_s2 CASCADE").await;

        // Planning can be cancelled (a slow count): nothing runs.
        let task = "tpm-it-cancel-plan".to_string();
        let e2 = engine.clone();
        let sid2 = sid.to_string();
        let t2 = task.clone();
        let h = tokio::spawn(async move {
            let o = RunOptions { confirmed: true, task_id: Some(t2), ..Default::default() };
            e2.run_script(&sid2, "UPDATE tpm_it_rpe SET qty = 0 WHERE pg_sleep(1) IS NOT NULL", o, None).await
        });
        tokio::time::sleep(Duration::from_millis(400)).await;
        let t0 = Instant::now();
        assert!(engine.cancel_task(&task).await.unwrap(), "the task is known while planning");
        let r = h.await.unwrap().unwrap();
        assert!(r.cancelled && r.statements.is_empty(), "{r:?}");
        assert!(t0.elapsed() < Duration::from_secs(2));
        assert_ne!(qty(1).await, "0");
    }

    // A statement that matched nothing says so instead of saying nothing.
    for sql in ["UPDATE tpm_it_rpe SET qty = 0 WHERE id = -1", "DELETE FROM tpm_it_rpe WHERE id = -1"] {
        let r = engine.run_script(sid, sql, opts(true), None).await.unwrap();
        let note = r.statements[0].restore.clone().unwrap_or_else(|| panic!("{driver:?}: {sql}: no note"));
        assert_eq!((note.point_id, note.reason.as_deref()), (None, Some("no rows matched")), "{driver:?}: {sql}");
    }

    // The statement changed other rows than the ones read before it (a volatile WHERE): the point
    // is kept, with a warning.
    if driver == Driver::Postgres {
        run(engine, sid, "DROP SEQUENCE IF EXISTS tpm_it_rpe_seq").await;
        run(engine, sid, "CREATE SEQUENCE tpm_it_rpe_seq").await;
        let sql = "UPDATE tpm_it_rpe SET qty = qty + 10 WHERE id <= (SELECT nextval('tpm_it_rpe_seq'))";
        let r = engine.run_script(sid, sql, opts(true), None).await.unwrap();
        let note = r.statements[0].restore.clone().expect("note");
        assert!(note.point_id.is_some(), "{note:?}");
        let warning = note.warning.unwrap_or_default();
        assert!(warning.contains("rows changed"), "{warning:?}");
        run(engine, sid, "DROP SEQUENCE tpm_it_rpe_seq").await;
    } else {
        let r = engine.run_script(sid, "UPDATE tpm_it_rpe SET qty = qty WHERE id = 1", opts(true), None).await.unwrap();
        let note = r.statements[0].restore.clone().expect("note");
        // MySQL counts only the rows whose values changed: not a mismatch.
        assert_eq!(note.warning, None, "{driver:?}");
    }

    // Runs that ask for no restore points (SQL files) keep none.
    let o = RunOptions { confirmed: true, keep_restore_points: Some(false), ..Default::default() };
    let r = engine.run_script(sid, "DELETE FROM tpm_it_rpe WHERE id = 3", o, None).await.unwrap();
    assert!(r.statements[0].restore.is_none(), "{driver:?}");
    run(engine, sid, "DROP TABLE tpm_it_rpe").await;
}

/// Restoring real-world tables: dropped tables with indexes and sequences, tables without a key,
/// generated and identity columns, columns SQL can't compare, and points still pending.
async fn restore_point_restores(engine: &Arc<Engine>, sid: &str, schema: &str, driver: Driver) {
    use tpm_core::restore::RestoreStore;
    let store = Arc::new(tpm_core::storage::Storage::open_in_memory().unwrap());
    engine.set_restore_store(store.clone());
    let opts = RunOptions { confirmed: true, ..Default::default() };
    let point = |r: &tpm_core::engine::ScriptResult| {
        r.statements.last().and_then(|s| s.restore.clone()).and_then(|n| n.point_id).expect("saved")
    };
    let rows = |sql: &'static str| async move { run(engine, sid, sql).await.statements[0].rows.clone().unwrap() };

    // A dropped table with an index (and on PostgreSQL a serial key and a comment) comes back.
    run(engine, sid, "DROP TABLE IF EXISTS tpm_it_rpd").await;
    let key = if driver == Driver::Postgres { "id serial PRIMARY KEY" } else { "id integer PRIMARY KEY" };
    run(engine, sid, &format!("CREATE TABLE tpm_it_rpd ({key}, note varchar(20))")).await;
    run(engine, sid, "CREATE INDEX tpm_it_rpd_note ON tpm_it_rpd (note)").await;
    if driver == Driver::Postgres {
        run(engine, sid, "COMMENT ON COLUMN tpm_it_rpd.note IS 'a note; with a semicolon'").await;
        run(engine, sid, "INSERT INTO tpm_it_rpd (note) VALUES ('a'), ('b')").await;
    } else {
        run(engine, sid, "INSERT INTO tpm_it_rpd VALUES (1, 'a'), (2, 'b')").await;
    }
    let r = engine.run_script(sid, "DROP TABLE tpm_it_rpd", opts.clone(), None).await.unwrap();
    let id = point(&r);
    engine.apply_restore(sid, &id, None, true).await.unwrap_or_else(|e| panic!("{driver:?}: {e:?}"));
    assert_eq!(rows("SELECT id, note FROM tpm_it_rpd ORDER BY id").await.len(), 2, "{driver:?}");
    if driver == Driver::Postgres {
        run(engine, sid, "INSERT INTO tpm_it_rpd (note) VALUES ('c')").await;
        let r = rows("SELECT max(id) FROM tpm_it_rpd").await;
        assert_eq!(text(&r[0][0]), "3", "the sequence continues after the restored rows");
    }
    run(engine, sid, "DROP TABLE tpm_it_rpd").await;

    // A grid commit says, per table, whether it kept a restore point and why not.
    run(engine, sid, "DROP TABLE IF EXISTS tpm_it_rpk").await;
    run(engine, sid, "CREATE TABLE tpm_it_rpk (id integer PRIMARY KEY, qty integer)").await;
    run(engine, sid, "INSERT INTO tpm_it_rpk VALUES (1, 1), (2, 2)").await;
    let edit = |id: &str, column: &str, value: &str, original: &str| ChangeSet {
        schema: schema.into(),
        table: "tpm_it_rpk".into(),
        changes: vec![RowChange::Update {
            key: vec![ColumnValue { column: "id".into(), value: Some(id.into()) }],
            edits: vec![ColumnEdit {
                column: column.into(),
                value: EditValue::Value { value: Some(value.into()) },
                original: Some(Some(original.into())),
            }],
        }],
        check_conflicts: true,
    };
    let r = engine.apply_change_sets_noted(sid, &[edit("1", "qty", "5", "1")], true).await.unwrap();
    assert_eq!(r.counts, vec![1]);
    assert!(r.restore.len() == 1 && r.restore[0].point_id.is_some(), "{driver:?}: {:?}", r.restore);
    let r = engine.apply_change_sets_noted(sid, &[edit("2", "id", "20", "2")], true).await.unwrap();
    assert_eq!(r.restore.len(), 1, "{driver:?}");
    assert_eq!(r.restore[0].reason.as_deref(), Some("changes the primary key"), "{driver:?}");
    run(engine, sid, "DROP TABLE tpm_it_rpk").await;

    // A table without a key: rows come back all at once, and only once.
    run(engine, sid, "DROP TABLE IF EXISTS tpm_it_rpn").await;
    run(engine, sid, "CREATE TABLE tpm_it_rpn (a integer)").await;
    run(engine, sid, "INSERT INTO tpm_it_rpn VALUES (1), (1), (2)").await;
    let r = engine.run_script(sid, "DELETE FROM tpm_it_rpn WHERE a = 1", opts.clone(), None).await.unwrap();
    let id = point(&r);
    assert!(
        engine.apply_restore(sid, &id, Some(vec![0]), true).await.is_err(),
        "{driver:?}: no chosen rows without a key"
    );
    engine.apply_restore(sid, &id, None, true).await.unwrap();
    let err = engine.apply_restore(sid, &id, None, true).await.unwrap_err();
    assert!(err.message.contains("already"), "{driver:?}: {}", err.message);
    assert_eq!(text(&rows("SELECT count(*) FROM tpm_it_rpn").await[0][0]), "3", "{driver:?}");
    run(engine, sid, "DROP TABLE tpm_it_rpn").await;

    // Generated columns (and PostgreSQL identity columns) are left to the database.
    {
        run(engine, sid, "DROP TABLE IF EXISTS tpm_it_rpg").await;
        let ddl = match driver {
            Driver::Duckdb => {
                "CREATE TABLE tpm_it_rpg (id integer PRIMARY KEY, qty integer, total integer GENERATED ALWAYS AS (qty * 2) VIRTUAL)"
            }
            Driver::Postgres => {
                "CREATE TABLE tpm_it_rpg (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, qty integer, total integer GENERATED ALWAYS AS (qty * 2) STORED)"
            }
            Driver::Sqlite => {
                "CREATE TABLE tpm_it_rpg (id integer PRIMARY KEY, qty integer, total integer GENERATED ALWAYS AS (qty * 2) STORED)"
            }
            _ => {
                "CREATE TABLE tpm_it_rpg (id integer PRIMARY KEY, qty integer, total integer GENERATED ALWAYS AS (qty * 2) STORED)"
            }
        };
        run(engine, sid, ddl).await;
        let st = engine.table_structure(sid, schema, "tpm_it_rpg", true).await.unwrap();
        let total = st.columns.iter().find(|c| c.name == "total").unwrap();
        assert!(total.generated, "{driver:?}: {total:?}");
        assert!(!st.columns.iter().find(|c| c.name == "qty").unwrap().generated, "{driver:?}");
        if driver == Driver::Postgres {
            run(engine, sid, "INSERT INTO tpm_it_rpg (qty) VALUES (1), (2)").await;
        } else {
            run(engine, sid, "INSERT INTO tpm_it_rpg (id, qty) VALUES (1, 1), (2, 2)").await;
        }
        let r = engine.run_script(sid, "UPDATE tpm_it_rpg SET qty = 5 WHERE id = 1", opts.clone(), None).await.unwrap();
        engine.apply_restore(sid, &point(&r), None, true).await.unwrap_or_else(|e| panic!("{driver:?}: {e:?}"));
        let r = engine.run_script(sid, "DELETE FROM tpm_it_rpg WHERE id = 2", opts.clone(), None).await.unwrap();
        engine.apply_restore(sid, &point(&r), None, true).await.unwrap_or_else(|e| panic!("{driver:?}: {e:?}"));
        let back = rows("SELECT id, qty, total FROM tpm_it_rpg ORDER BY id").await;
        assert_eq!(
            back.iter().map(|r| (text(&r[1]).to_string(), text(&r[2]).to_string())).collect::<Vec<_>>(),
            vec![("1".into(), "2".into()), ("2".into(), "4".into())],
            "{driver:?}"
        );
        run(engine, sid, "DROP TABLE tpm_it_rpg").await;
    }

    // A column SQL can't compare (MySQL JSON): a later change still stops the restore.
    if matches!(driver, Driver::Mysql | Driver::Mariadb) {
        run(engine, sid, "DROP TABLE IF EXISTS tpm_it_rpj").await;
        run(engine, sid, "CREATE TABLE tpm_it_rpj (id integer PRIMARY KEY, doc json)").await;
        run(engine, sid, "INSERT INTO tpm_it_rpj VALUES (1, '{\"a\": 1}')").await;
        let r = engine
            .run_script(sid, "UPDATE tpm_it_rpj SET doc = '{\"a\": 2}' WHERE id = 1", opts.clone(), None)
            .await
            .unwrap();
        let id = point(&r);
        run(engine, sid, "UPDATE tpm_it_rpj SET doc = '{\"a\": 3}' WHERE id = 1").await;
        let err = engine.apply_restore(sid, &id, None, true).await.unwrap_err();
        assert_eq!(err.kind, ErrorKind::Conflict, "{driver:?}");
        assert!(text(&rows("SELECT doc FROM tpm_it_rpj").await[0][0]).contains('3'), "{driver:?}");
        run(engine, sid, "DROP TABLE tpm_it_rpj").await;
    }

    // A point whose transaction is still open can't be restored.
    if driver == Driver::Postgres {
        run(engine, sid, "CREATE TABLE tpm_it_rpp (id integer PRIMARY KEY, qty integer)").await;
        run(engine, sid, "INSERT INTO tpm_it_rpp VALUES (1, 1)").await;
        run(engine, sid, "BEGIN").await;
        let r = engine.run_script(sid, "UPDATE tpm_it_rpp SET qty = 2", opts.clone(), None).await.unwrap();
        let id = point(&r);
        run(engine, sid, "COMMIT").await;
        // Pending in the store (as after a crash mid-transaction), whatever the session says.
        store.set_status(std::slice::from_ref(&id), tpm_core::restore::RestoreStatus::Pending).unwrap();
        let err = engine.apply_restore(sid, &id, None, true).await.unwrap_err();
        assert!(err.message.contains("transaction"), "{}", err.message);
        run(engine, sid, "DROP TABLE tpm_it_rpp").await;
    }
}

/// System tables are never edited from results, and a failed COMMIT leaves no restore points.
async fn safety_fixes(engine: &Arc<Engine>, sid: &str, driver: Driver) {
    use tpm_core::restore::RestoreStore;
    // System tables: read-only in results, and the backend refuses a commit to them. The key
    // below matches no row, so even a broken refusal would change nothing.
    let system = match driver {
        Driver::Postgres => Some((
            "pg_catalog",
            "pg_description",
            "SELECT objoid, classoid, objsubid, description FROM pg_catalog.pg_description LIMIT 1",
            vec![("objoid", "0"), ("classoid", "0"), ("objsubid", "0")],
            "description",
        )),
        Driver::Mysql | Driver::Mariadb => Some((
            "mysql",
            "db",
            "SELECT Host, Db, User, Select_priv FROM mysql.db LIMIT 1",
            vec![("Host", "tpm-none"), ("Db", "tpm-none"), ("User", "tpm-none")],
            "Select_priv",
        )),
        _ => None,
    };
    if let Some((schema, table, select, key, column)) = system {
        let r = run(engine, sid, select).await;
        if let Some(editing) = r.statements[0].editing.clone()
            && r.statements[0].columns.as_ref().is_some_and(|c| c.iter().any(|c| c.origin.is_some()))
        {
            assert!(editing.tables.is_empty(), "{driver:?}: {editing:?}");
            assert!(editing.read_only.iter().any(|r| r.reason.contains("system table")), "{driver:?}: {editing:?}");
        }
        let set = ChangeSet {
            schema: schema.into(),
            table: table.into(),
            changes: vec![RowChange::Update {
                key: key.iter().map(|(c, v)| ColumnValue { column: (*c).into(), value: Some((*v).into()) }).collect(),
                edits: vec![ColumnEdit {
                    column: column.into(),
                    value: EditValue::Value { value: Some("x".into()) },
                    original: None,
                }],
            }],
            check_conflicts: true,
        };
        let err = engine.apply_change_sets(sid, &[set], true).await.unwrap_err();
        assert_eq!(err.kind, ErrorKind::PolicyViolation, "{driver:?}: {err:?}");
        assert!(err.message.contains("system table"), "{driver:?}: {}", err.message);
    }

    // PostgreSQL: a COMMIT that fails (a deferred constraint) rolls the transaction back. Its
    // restore points go, and the session is out of the transaction (grid commits work again).
    if driver == Driver::Postgres {
        let store = Arc::new(tpm_core::storage::Storage::open_in_memory().unwrap());
        engine.set_restore_store(store.clone());
        run(engine, sid, "DROP TABLE IF EXISTS tpm_it_child").await;
        run(engine, sid, "DROP TABLE IF EXISTS tpm_it_parent").await;
        run(engine, sid, "CREATE TABLE tpm_it_parent (id integer PRIMARY KEY)").await;
        run(engine, sid, "CREATE TABLE tpm_it_child (id integer PRIMARY KEY, pid integer REFERENCES tpm_it_parent DEFERRABLE INITIALLY DEFERRED, qty integer)").await;
        run(engine, sid, "INSERT INTO tpm_it_parent VALUES (1)").await;
        run(engine, sid, "INSERT INTO tpm_it_child VALUES (1, 1, 1)").await;
        run(engine, sid, "BEGIN").await;
        let opts = RunOptions { confirmed: true, ..Default::default() };
        let r =
            engine.run_script(sid, "UPDATE tpm_it_child SET qty = 5 WHERE id = 1", opts.clone(), None).await.unwrap();
        let id = r.statements[0].restore.as_ref().and_then(|n| n.point_id.clone()).expect("saved");
        run(engine, sid, "INSERT INTO tpm_it_child VALUES (2, 999, 0)").await; // breaks the FK at COMMIT
        let r = engine.run_script(sid, "COMMIT", opts.clone(), None).await.unwrap();
        assert!(r.statements[0].error.is_some(), "the deferred constraint fails the COMMIT");
        assert!(store.get(&id).is_err(), "the transaction was rolled back: no restore point");
        let r = run(engine, sid, "SELECT qty FROM tpm_it_child WHERE id = 1").await;
        assert_eq!(text(&r.statements[0].rows.as_ref().unwrap()[0][0]), "1");
        // Out of the transaction: a grid commit is allowed again.
        let set = ChangeSet {
            schema: "public".into(),
            table: "tpm_it_child".into(),
            changes: vec![RowChange::Update {
                key: vec![ColumnValue { column: "id".into(), value: Some("1".into()) }],
                edits: vec![ColumnEdit {
                    column: "qty".into(),
                    value: EditValue::Value { value: Some("2".into()) },
                    original: Some(Some("1".into())),
                }],
            }],
            check_conflicts: true,
        };
        engine.apply_changes(sid, &set, true).await.unwrap();
        run(engine, sid, "DROP TABLE tpm_it_child").await;
        run(engine, sid, "DROP TABLE tpm_it_parent").await;
    }
}

/// Query results know their column types (so JSON opens in the JSON editor) inside a transaction
/// and on read-only connections too, without disturbing the transaction.
async fn result_types(
    engine: &Arc<Engine>,
    sid: &str,
    driver: Driver,
    profile: &ConnectionProfile,
    password: Option<&str>,
) {
    if driver != Driver::Postgres {
        return;
    }
    let sql = "SELECT '{\"a\": 1}'::jsonb AS doc, 1 AS n";
    run(engine, sid, "BEGIN").await;
    let r = run(engine, sid, sql).await;
    let cols = r.statements[0].columns.clone().unwrap();
    assert_eq!(cols[0].type_name, "jsonb", "inside a transaction: {cols:?}");
    run(engine, sid, "SELECT 1").await; // the transaction is still usable
    run(engine, sid, "ROLLBACK").await;
    let ro = ConnectionProfile { safety_mode: SafetyMode::ReadOnly, ..profile.clone() };
    let info = engine.open_session(&ro, password, None, ConnectOptions::default()).await.expect("connect");
    let r = run(engine, &info.session_id, sql).await;
    let st = &r.statements[0];
    assert_eq!(st.columns.as_ref().unwrap()[0].type_name, "jsonb", "read-only: {:?}", st.columns);
    assert_eq!(st.editing.as_ref().unwrap().read_only[0].reason, "Read-only connection");
    engine.close_session(&info.session_id).await;
}

/// `:name` placeholders are bound as values (never pasted into the SQL) on every database; a
/// write with parameters keeps no restore point and asks first.
async fn query_parameters(engine: &Arc<Engine>, sid: &str, driver: Driver) {
    use std::collections::HashMap;
    let store = Arc::new(tpm_core::storage::Storage::open_in_memory().unwrap());
    engine.set_restore_store(store);
    run(engine, sid, "DROP TABLE IF EXISTS tpm_it_qp").await;
    run(engine, sid, "CREATE TABLE tpm_it_qp (id integer PRIMARY KEY, name varchar(50))").await;
    run(engine, sid, "INSERT INTO tpm_it_qp VALUES (1, 'a'), (2, 'it''s')").await;
    let opts = |confirmed: bool, values: &[(&str, Option<&str>)]| RunOptions {
        confirmed,
        parameters: Some(values.iter().map(|(k, v)| (k.to_string(), v.map(str::to_string))).collect::<HashMap<_, _>>()),
        ..Default::default()
    };
    let sql = "SELECT name FROM tpm_it_qp WHERE id = :id OR name = :name ORDER BY id";
    let r = engine.run_script(sid, sql, opts(false, &[("id", Some("1")), ("name", Some("it's"))]), None).await.unwrap();
    let rows = r.statements[0].rows.clone().unwrap_or_else(|| panic!("{driver:?}: {r:?}"));
    assert_eq!(rows.iter().map(|r| text(&r[0]).to_string()).collect::<Vec<_>>(), ["a", "it's"], "{driver:?}");

    let r = engine
        .run_script(sid, "SELECT count(*) FROM tpm_it_qp WHERE name = :n", opts(false, &[("n", None)]), None)
        .await
        .unwrap();
    assert_eq!(
        text(&r.statements[0].rows.as_ref().unwrap()[0][0]),
        "0",
        "{driver:?}: NULL is bound, not the text NULL"
    );

    let update = "UPDATE tpm_it_qp SET name = :name WHERE id = :id";
    let err =
        engine.run_script(sid, update, opts(false, &[("name", Some("b")), ("id", Some("1"))]), None).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::ConfirmationRequired, "{driver:?}: {err:?}");
    assert!(err.detail.as_deref().unwrap_or("").contains("uses parameters"), "{driver:?}: {err:?}");
    let r = engine.run_script(sid, update, opts(true, &[("name", Some("b")), ("id", Some("1"))]), None).await.unwrap();
    let st = &r.statements[0];
    assert!(st.error.is_none(), "{driver:?}: {:?}", st.error);
    assert_eq!(st.rows_affected, Some(1), "{driver:?}");
    assert_eq!(st.restore.as_ref().and_then(|n| n.reason.as_deref()), Some("uses parameters"), "{driver:?}");
    let back = run(engine, sid, "SELECT name FROM tpm_it_qp WHERE id = 1").await;
    assert_eq!(text(&back.statements[0].rows.as_ref().unwrap()[0][0]), "b", "{driver:?}");

    let err = engine.run_script(sid, sql, opts(false, &[("id", Some("1"))]), None).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::InvalidConfig, "{driver:?}: {err:?}");
    assert!(err.message.contains(":name"), "{}", err.message);
    let r = run(engine, sid, "SELECT ':x' AS t").await;
    assert_eq!(text(&r.statements[0].rows.as_ref().unwrap()[0][0]), ":x");
    run(engine, sid, "DROP TABLE tpm_it_qp").await;
}

/// A statement run with bound parameters shows exactly what the same statement shows without them
/// (every column type the database renders as text), keeps RETURNING rows, and stops at the row cap.
async fn bound_results_match_plain_runs(engine: &Arc<Engine>, sid: &str, driver: Driver) {
    use std::collections::HashMap;
    let (ddl, row) = match driver {
        Driver::Postgres => (
            "CREATE TABLE tpm_it_bt (id integer PRIMARY KEY, n numeric(10,2), ts timestamp, tz timestamptz, d date, \
             u uuid, iv interval, ip inet, arr integer[], j jsonb, b bytea, f float8, ok boolean, t text)",
            "(1, 12.50, '2026-01-02 03:04:05.678', '2026-01-02 03:04:05+00', '2026-01-02', \
             'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '1 day 02:03:04', '10.0.0.1/24', '{1,2}', '{\"a\": [1, 2]}', '\\xdead', 1.5, true, 'x')",
        ),
        Driver::Mysql | Driver::Mariadb => (
            "CREATE TABLE tpm_it_bt (id integer PRIMARY KEY, n decimal(10,2), ts datetime(3), d date, tm time, f double, \
             j json, b varbinary(8), t varchar(20))",
            "(1, 12.50, '2026-01-02 03:04:05.678', '2026-01-02', '03:04:05', 1.5, '{\"a\": [1, 2]}', X'DEAD', 'x')",
        ),
        Driver::Duckdb => (
            "CREATE TABLE tpm_it_bt (id integer PRIMARY KEY, n decimal(10,2), ts timestamp, d date, l integer[], \
             st struct(a integer), b blob, f double, t varchar)",
            "(1, 12.50, '2026-01-02 03:04:05.678', '2026-01-02', [1, 2], {'a': 1}, '\\xDE\\xAD'::BLOB, 1.5, 'x')",
        ),
        _ => ("CREATE TABLE tpm_it_bt (id integer PRIMARY KEY, n real, b blob, t text)", "(1, 12.5, X'DEAD', 'x')"),
    };
    run(engine, sid, "DROP TABLE IF EXISTS tpm_it_bt").await;
    run(engine, sid, ddl).await;
    run(engine, sid, &format!("INSERT INTO tpm_it_bt VALUES {row}")).await;
    let with = |values: &[(&str, &str)], max_rows: Option<usize>| RunOptions {
        confirmed: true,
        max_rows,
        parameters: Some(values.iter().map(|(k, v)| (k.to_string(), Some(v.to_string()))).collect::<HashMap<_, _>>()),
        ..Default::default()
    };
    let plain = run(engine, sid, "SELECT * FROM tpm_it_bt WHERE id = 1").await;
    let bound = engine
        .run_script(sid, "SELECT * FROM tpm_it_bt WHERE id = :id", with(&[("id", "1")], None), None)
        .await
        .unwrap();
    let (p, b) = (&plain.statements[0], &bound.statements[0]);
    assert!(b.error.is_none(), "{driver:?}: {:?}", b.error);
    let names = |st: &tpm_core::engine::StatementResult| {
        st.columns.as_ref().unwrap().iter().map(|c| c.name.clone()).collect::<Vec<_>>()
    };
    assert_eq!(names(b), names(p), "{driver:?}");
    assert_eq!(b.rows, p.rows, "{driver:?}");

    // RETURNING rows come back (MySQL has no RETURNING).
    if driver != Driver::Mysql {
        let r = engine
            .run_script(
                sid,
                "INSERT INTO tpm_it_bt (id, t) VALUES (:id, :t) RETURNING id, t",
                with(&[("id", "2"), ("t", "y")], None),
                None,
            )
            .await
            .unwrap();
        let st = &r.statements[0];
        assert!(st.error.is_none(), "{driver:?}: {:?}", st.error);
        let rows = st.rows.clone().unwrap_or_else(|| panic!("{driver:?}: no rows {st:?}"));
        assert_eq!(
            rows.iter().map(|r| (text(&r[0]).to_string(), text(&r[1]).to_string())).collect::<Vec<_>>(),
            [("2".to_string(), "y".to_string())],
            "{driver:?}"
        );
    } else {
        run(engine, sid, "INSERT INTO tpm_it_bt (id, t) VALUES (2, 'y')").await;
    }
    run(engine, sid, "INSERT INTO tpm_it_bt (id, t) VALUES (3, 'z')").await;
    // The row cap holds on the bound path too.
    let r = engine
        .run_script(sid, "SELECT id FROM tpm_it_bt WHERE id > :min ORDER BY id", with(&[("min", "0")], Some(1)), None)
        .await
        .unwrap();
    let st = &r.statements[0];
    assert!(st.error.is_none(), "{driver:?}: {:?}", st.error);
    assert_eq!(st.rows.as_ref().map(|r| r.len()), Some(1), "{driver:?}");
    assert!(st.truncated, "{driver:?}");
    let after = run(engine, sid, "SELECT count(*) FROM tpm_it_bt").await;
    assert_eq!(text(&after.statements[0].rows.as_ref().unwrap()[0][0]), "3", "{driver:?}: the session still works");
    run(engine, sid, "DROP TABLE tpm_it_bt").await;
}

/// Rows copied as INSERT statements (as the grid copies them: cells from a query result) run on
/// the same database and give back the same values: binary, quotes, backslashes, NULL.
async fn copied_inserts_round_trip(engine: &Arc<Engine>, sid: &str, driver: Driver) {
    use tpm_core::transfer::{ExportFormat, ExportOptions, rows_as_text};
    let (blob, text_type) = match driver {
        Driver::Postgres => ("bytea", "text"),
        Driver::Mysql | Driver::Mariadb => ("varbinary(16)", "varchar(50)"),
        _ => ("blob", "text"),
    };
    let ddl = |name: &str| format!("CREATE TABLE {name} (id integer PRIMARY KEY, b {blob}, s {text_type})");
    run(engine, sid, "DROP TABLE IF EXISTS tpm_it_cp1").await;
    run(engine, sid, "DROP TABLE IF EXISTS tpm_it_cp2").await;
    run(engine, sid, &ddl("tpm_it_cp1")).await;
    run(engine, sid, &ddl("tpm_it_cp2")).await;
    let insert = match driver {
        Driver::Postgres => r"INSERT INTO tpm_it_cp1 VALUES (1, '\xdead005c'::bytea, 'it''s a\b'), (2, NULL, NULL)",
        Driver::Duckdb => r"INSERT INTO tpm_it_cp1 VALUES (1, '\xDE\xAD\x00\x5C'::BLOB, 'it''s a\b'), (2, NULL, NULL)",
        Driver::Mysql | Driver::Mariadb => {
            r"INSERT INTO tpm_it_cp1 VALUES (1, X'DEAD005C', 'it''s a\\b'), (2, NULL, NULL)"
        }
        _ => r"INSERT INTO tpm_it_cp1 VALUES (1, X'DEAD005C', 'it''s a\b'), (2, NULL, NULL)",
    };
    run(engine, sid, insert).await;
    let r = run(engine, sid, "SELECT id, b, s FROM tpm_it_cp1 ORDER BY id").await;
    let st = &r.statements[0];
    let (columns, rows) = (st.columns.clone().unwrap(), st.rows.clone().unwrap());
    // PostgreSQL (text protocol) and DuckDB render binary values as their own escaped text; the
    // others return the bytes.
    match driver {
        Driver::Postgres => assert_eq!(text(&rows[0][1]), r"\xdead005c"),
        Driver::Duckdb => assert_eq!(text(&rows[0][1]), r"\xDE\xAD\x00\x5C"),
        _ => assert!(
            matches!(rows[0][1], Cell::Bytes(ref b) if b == &[0xde, 0xad, 0x00, 0x5c]),
            "{driver:?}: {:?}",
            rows[0][1]
        ),
    }
    assert_eq!(text(&rows[0][2]), r"it's a\b", "{driver:?}");
    let opts = ExportOptions {
        format: ExportFormat::Sql,
        delimiter: ',',
        header: false,
        null_text: String::new(),
        sql_table: Some("tpm_it_cp2".into()),
        sql_schema: None,
        dialect: Some(driver.dialect()),
        sql_batch: 1,
    };
    let sql = rows_as_text(&columns, &rows, &opts).unwrap();
    run(engine, sid, &sql).await;
    let check = "SELECT count(*) FROM tpm_it_cp1 a JOIN tpm_it_cp2 b ON a.id = b.id \
                 WHERE (a.b = b.b OR (a.b IS NULL AND b.b IS NULL)) AND (a.s = b.s OR (a.s IS NULL AND b.s IS NULL))";
    let same = run(engine, sid, check).await;
    assert_eq!(text(&same.statements[0].rows.as_ref().unwrap()[0][0]), "2", "{driver:?}: {sql}");
    run(engine, sid, "DROP TABLE tpm_it_cp1").await;
    run(engine, sid, "DROP TABLE tpm_it_cp2").await;
}

/// An equality filter on the text the grid shows finds the row even where the stored value is
/// not text: SQLite columns with no declared type, MySQL FLOAT (the foreign-key jump relies on it).
async fn text_equality(engine: &Arc<Engine>, sid: &str, schema: &str, driver: Driver) {
    let (ddl, insert, column, value) = match driver {
        Driver::Sqlite => ("CREATE TABLE tpm_it_teq (k, v TEXT)", "INSERT INTO tpm_it_teq VALUES (42, 'a')", "k", "42"),
        Driver::Mysql | Driver::Mariadb => {
            ("CREATE TABLE tpm_it_teq (k FLOAT, v TEXT)", "INSERT INTO tpm_it_teq VALUES (0.1, 'a')", "k", "0.1")
        }
        _ => return,
    };
    run(engine, sid, "DROP TABLE IF EXISTS tpm_it_teq").await;
    run(engine, sid, ddl).await;
    run(engine, sid, insert).await;
    // The value as the grid shows it.
    let shown = run(engine, sid, &format!("SELECT {column} FROM tpm_it_teq")).await;
    assert_eq!(text(&shown.statements[0].rows.as_ref().unwrap()[0][0]), value, "{driver:?}");
    let req = BrowseRequest {
        schema: schema.into(),
        table: "tpm_it_teq".into(),
        filter: Some(FilterNode::Condition {
            column: column.into(),
            op: FilterOp::Eq,
            value: Some(value.into()),
            value2: None,
            values: vec![],
            enabled: true,
        }),
        limit: 10,
        ..Default::default()
    };
    let page = engine.browse(sid, &req).await.unwrap();
    assert_eq!(page.rows.len(), 1, "{driver:?}: {}", page.sql);
    run(engine, sid, "DROP TABLE tpm_it_teq").await;
}

/// Following a foreign key: the referenced columns are known (even when the DDL left them
/// implicit) and an `eq` filter on the referencing cell's text finds exactly that row.
async fn fk_round_trip(engine: &Arc<Engine>, sid: &str, schema: &str, driver: Driver) {
    use tpm_core::browse::BrowseRequest;
    let child_cols = match driver {
        // SQLite and PostgreSQL allow `REFERENCES parent` without a column list (the parent's key).
        Driver::Sqlite | Driver::Postgres => "parent_id integer REFERENCES tpm_it_fkp",
        // MySQL ignores column-level REFERENCES; a table-level constraint is the portable form.
        _ => "parent_id integer, FOREIGN KEY (parent_id) REFERENCES tpm_it_fkp (id)",
    };
    run(engine, sid, "DROP TABLE IF EXISTS tpm_it_fkc").await;
    run(engine, sid, "DROP TABLE IF EXISTS tpm_it_fkp").await;
    run(engine, sid, "CREATE TABLE tpm_it_fkp (id integer PRIMARY KEY, name varchar(20))").await;
    run(engine, sid, &format!("CREATE TABLE tpm_it_fkc (id integer PRIMARY KEY, {child_cols})")).await;
    run(engine, sid, "INSERT INTO tpm_it_fkp VALUES (42, 'forty-two'), (43, 'other')").await;
    run(engine, sid, "INSERT INTO tpm_it_fkc VALUES (1, 42)").await;
    let child = engine.table_structure(sid, schema, "tpm_it_fkc", true).await.unwrap();
    let fk = child.foreign_keys.first().unwrap_or_else(|| panic!("{driver:?}: no foreign key introspected"));
    assert_eq!(fk.columns, vec!["parent_id".to_string()], "{driver:?}");
    assert_eq!(fk.ref_columns, vec!["id".to_string()], "{driver:?}: referenced columns resolved");
    let req = BrowseRequest {
        schema: fk.ref_schema.clone(),
        table: fk.ref_table.clone(),
        limit: 150,
        filter: Some(FilterNode::Group {
            logic: Logic::And,
            negate: false,
            children: vec![FilterNode::Condition {
                column: fk.ref_columns[0].clone(),
                op: FilterOp::Eq,
                value: Some("42".into()),
                value2: None,
                values: vec![],
                enabled: true,
            }],
        }),
        ..Default::default()
    };
    let page = engine.browse(sid, &req).await.unwrap();
    assert_eq!(page.rows.len(), 1, "{driver:?}");
    assert_eq!(page.rows[0][0], Cell::Text("42".into()), "{driver:?}");
    run(engine, sid, "DROP TABLE tpm_it_fkc").await;
    run(engine, sid, "DROP TABLE tpm_it_fkp").await;
}

/// Opened tables leave unbounded columns out of the page; values come back by key on demand.
async fn lazy_values(engine: &Arc<Engine>, sid: &str, schema: &str, driver: Driver) {
    use tpm_core::browse::BrowseRequest;
    let (body_ty, doc_ty, big) = match driver {
        Driver::Postgres => ("text", "jsonb", "repeat('x', 100000)"),
        Driver::Mysql | Driver::Mariadb => ("longtext", "json", "REPEAT('x', 100000)"),
        Driver::Sqlite => ("TEXT", "TEXT", "replace(hex(zeroblob(50000)), '0', 'x')"),
        Driver::Duckdb => ("VARCHAR", "VARCHAR", "repeat('x', 100000)"),
        Driver::Mssql => ("nvarchar(max)", "nvarchar(max)", "REPLICATE(CAST('x' AS nvarchar(max)), 100000)"),
        Driver::Redis => unreachable!(),
    };
    run(engine, sid, "DROP TABLE IF EXISTS tpm_it_docs").await;
    run(engine, sid, "DROP TABLE IF EXISTS tpm_it_nokey").await;
    run(
        engine,
        sid,
        &format!("CREATE TABLE tpm_it_docs (id integer PRIMARY KEY, title varchar(50), body {body_ty}, doc {doc_ty})"),
    )
    .await;
    run(
        engine,
        sid,
        &format!("INSERT INTO tpm_it_docs VALUES (1, 'one', {big}, '{{\"a\": 1}}'), (2, 'two', 'short', NULL)"),
    )
    .await;
    run(engine, sid, &format!("CREATE TABLE tpm_it_nokey (body {body_ty})")).await;
    run(engine, sid, "INSERT INTO tpm_it_nokey VALUES ('kept')").await;

    let req = BrowseRequest {
        schema: schema.into(),
        table: "tpm_it_docs".into(),
        limit: 150,
        lazy: true,
        ..Default::default()
    };
    let page = engine.browse(sid, &req).await.unwrap();
    let names: Vec<(&str, bool)> = page.columns.iter().map(|c| (c.name.as_str(), c.deferred)).collect();
    // DuckDB reports every VARCHAR without its declared length, so `title` is unbounded there too.
    let title_deferred = driver == Driver::Duckdb;
    assert_eq!(names, vec![("id", false), ("title", title_deferred), ("body", true), ("doc", true)], "{driver:?}");
    assert_eq!(page.rows[0][2], Cell::NotLoaded, "{driver:?}");
    assert_eq!(page.rows[0][3], Cell::NotLoaded, "{driver:?}");
    let select_list = &page.sql[..page.sql.find(" FROM ").unwrap()];
    assert!(
        !select_list.contains("body") && !select_list.contains("doc"),
        "page query never names deferred columns: {}",
        page.sql
    );

    // One value, by key.
    let key = |id: &str| vec![ColumnValue { column: "id".into(), value: Some(id.into()) }];
    let body = engine.fetch_value(sid, schema, "tpm_it_docs", key("1"), "body").await.unwrap();
    assert_eq!(body.as_text().map(str::len), Some(100_000), "{driver:?}");
    // A column for several rows, matched by key whatever order the database returns.
    let got = engine.fetch_column(sid, schema, "tpm_it_docs", "body", &[key("2"), key("1"), key("9")]).await.unwrap();
    assert_eq!(got[0].value, Cell::Text("short".into()));
    assert_eq!(got[1].value.as_text().map(str::len), Some(100_000));
    assert!(!got[2].found, "missing row reported, not invented");
    // Overrides: load body normally, defer title.
    let req2 = BrowseRequest { load_columns: vec!["body".into()], defer_columns: vec!["title".into()], ..req.clone() };
    let page = engine.browse(sid, &req2).await.unwrap();
    assert_eq!(page.rows[1][2], Cell::Text("short".into()));
    assert_eq!(page.rows[1][1], Cell::NotLoaded);
    // A table without a key defers nothing.
    let nk = BrowseRequest { table: "tpm_it_nokey".into(), ..req.clone() };
    let page = engine.browse(sid, &nk).await.unwrap();
    assert_eq!(page.rows[0][0], Cell::Text("kept".into()));
    // Not lazy (export, other callers): everything, as before.
    let full = engine.browse(sid, &BrowseRequest { lazy: false, ..req.clone() }).await.unwrap();
    assert_eq!(full.rows[0][2].as_text().map(str::len), Some(100_000));
    // A query tab returns every column in full.
    let r = run(engine, sid, "SELECT * FROM tpm_it_docs WHERE id = 1").await;
    assert_eq!(r.statements[0].rows.as_ref().unwrap()[0][2].as_text().map(str::len), Some(100_000), "{driver:?}");
    // Query results: long text goes to the UI as a preview; the full value stays in memory.
    let opts = RunOptions { confirmed: true, large_value_chars: Some(256), ..Default::default() };
    let r = engine.run_script(sid, "SELECT id, body, title FROM tpm_it_docs WHERE id = 1", opts, None).await.unwrap();
    let st = &r.statements[0];
    match &st.rows.as_ref().unwrap()[0][1] {
        Cell::Partial { preview, length } => {
            assert_eq!(*length, 100_000);
            assert_eq!(preview.chars().count(), 80);
        }
        other => panic!("{driver:?}: expected a preview, got {other:?}"),
    }
    assert_eq!(st.rows.as_ref().unwrap()[0][2], Cell::Text("one".into()), "short values untouched");
    let rid = st.result_id.clone().unwrap();
    assert_eq!(engine.result_value(&rid, 0, 1).unwrap().as_text().map(str::len), Some(100_000));
    assert!(matches!(engine.fetch_rows(&rid, 0, 10).unwrap()[0][1], Cell::Partial { .. }), "later pages too");
    let (_, full) = engine.result_snapshot(&rid).unwrap();
    assert_eq!(full[0][1].as_text().map(str::len), Some(100_000), "export reads full rows");
    engine.release_results(std::slice::from_ref(&rid));
    assert_eq!(
        engine.result_value(&rid, 0, 1).unwrap_err().message,
        "This result is no longer in memory; run the query again"
    );
    if driver == Driver::Postgres {
        let r = run(engine, sid, "SELECT doc FROM tpm_it_docs WHERE id = 1").await;
        assert_eq!(
            r.statements[0].columns.as_ref().unwrap()[0].type_name,
            "jsonb",
            "writable PG results learn their types"
        );
    }
    // Deleted between page and click.
    run(engine, sid, "DELETE FROM tpm_it_docs WHERE id = 2").await;
    let err = engine.fetch_value(sid, schema, "tpm_it_docs", key("2"), "body").await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::NotFound);
    assert_eq!(err.message, "This row no longer exists");

    run(engine, sid, "DROP TABLE tpm_it_docs").await;
    run(engine, sid, "DROP TABLE tpm_it_nokey").await;
}

/// Edit query results across two tables in one transaction; refuse on conflict; block where the rule says so.
async fn edit_results(engine: &Engine, sid: &str, profile: &ConnectionProfile, password: Option<&str>, driver: Driver) {
    let r = run(
        engine,
        sid,
        "SELECT i.id, i.name, o.id, o.name FROM tpm_it_items i JOIN tpm_it_owners o ON o.id = i.owner_id ORDER BY i.id",
    )
    .await;
    let st = &r.statements[0];
    let editing = st.editing.clone().expect("editing info");
    if driver == Driver::Duckdb {
        assert!(editing.tables.is_empty());
        assert_eq!(editing.read_only[0].reason, "Query results can't be edited on DuckDB");
        return;
    }
    assert_eq!(editing.tables.len(), 2, "{driver:?}: {editing:?}");
    assert_eq!(editing.columns, vec![Some(0), Some(0), Some(1), Some(1)]);
    // The key shown twice (once through *, once under another name) is still one row.
    let twice = run(engine, sid, "SELECT id, name, id AS x FROM tpm_it_items ORDER BY id").await;
    let e2 = twice.statements[0].editing.clone().expect("editing info");
    assert_eq!(e2.tables.len(), 1, "{driver:?}: {e2:?}");
    assert_eq!(e2.columns, vec![Some(0), Some(0), Some(0)], "{driver:?}: {e2:?}");
    // A real self-join stays read-only.
    let selfjoin =
        run(engine, sid, "SELECT a.id, a.name, b.id FROM tpm_it_items a JOIN tpm_it_items b ON b.id = a.id").await;
    let e3 = selfjoin.statements[0].editing.clone().expect("editing info");
    assert!(e3.tables.is_empty(), "{driver:?}: {e3:?}");
    let row = &st.rows.as_ref().unwrap()[0];
    let item_id = text(&row[0]).to_string();
    let item_name = text(&row[1]).to_string();
    let owner_id = text(&row[2]).to_string();
    let owner_name = text(&row[3]).to_string();
    let edit = |col: &str, new: &str, old: &str| ColumnEdit {
        column: col.into(),
        value: EditValue::Value { value: Some(new.into()) },
        original: Some(Some(old.into())),
    };
    let schema = editing.tables[0].schema.clone();
    let sets = vec![
        ChangeSet {
            schema: schema.clone(),
            table: "tpm_it_items".into(),
            changes: vec![RowChange::Update {
                key: vec![ColumnValue { column: "id".into(), value: Some(item_id.clone()) }],
                edits: vec![edit("name", "renamed item", &item_name)],
            }],
            check_conflicts: true,
        },
        ChangeSet {
            schema: schema.clone(),
            table: "tpm_it_owners".into(),
            changes: vec![RowChange::Update {
                key: vec![ColumnValue { column: "id".into(), value: Some(owner_id.clone()) }],
                edits: vec![edit("name", "renamed owner", &owner_name)],
            }],
            check_conflicts: true,
        },
    ];
    let preview = engine.preview_change_sets(sid, &sets).await.unwrap();
    assert_eq!(preview.statement_count, 2);
    assert_eq!(engine.apply_change_sets(sid, &sets, false).await.unwrap_err().kind, ErrorKind::ConfirmationRequired);
    assert_eq!(engine.apply_change_sets(sid, &sets, true).await.unwrap(), vec![1, 1]);
    let after = run(engine, sid, &format!("SELECT name FROM tpm_it_items WHERE id = {item_id}")).await;
    assert_eq!(text(&after.statements[0].rows.as_ref().unwrap()[0][0]), "renamed item");

    // Conflict: a valid edit followed by a stale one. The stale one fails, and the valid one is rolled back.
    let one = |table: &str, id: &str, e: ColumnEdit| ChangeSet {
        schema: schema.clone(),
        table: table.into(),
        changes: vec![RowChange::Update {
            key: vec![ColumnValue { column: "id".into(), value: Some(id.into()) }],
            edits: vec![e],
        }],
        check_conflicts: true,
    };
    let stale = [
        one("tpm_it_items", &item_id, edit("name", "third item", "renamed item")),
        one("tpm_it_owners", &owner_id, edit("name", "third", "not the current name")),
    ];
    let err = engine.apply_change_sets(sid, &stale, true).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Conflict, "{driver:?}");
    let item = run(engine, sid, &format!("SELECT name FROM tpm_it_items WHERE id = {item_id}")).await;
    assert_eq!(text(&item.statements[0].rows.as_ref().unwrap()[0][0]), "renamed item", "rolled back ({driver:?})");
    let owner = run(engine, sid, &format!("SELECT name FROM tpm_it_owners WHERE id = {owner_id}")).await;
    assert_eq!(text(&owner.statements[0].rows.as_ref().unwrap()[0][0]), "renamed owner", "untouched ({driver:?})");

    // An open transaction in the tab: committing edits would commit or roll back the user's own work.
    run(engine, sid, "BEGIN").await;
    run(engine, sid, &format!("UPDATE tpm_it_owners SET name = 'inside txn' WHERE id = {owner_id}")).await;
    let fresh = vec![ChangeSet {
        schema: schema.clone(),
        table: "tpm_it_items".into(),
        changes: vec![RowChange::Update {
            key: vec![ColumnValue { column: "id".into(), value: Some(item_id.clone()) }],
            edits: vec![edit("name", "after txn", "renamed item")],
        }],
        check_conflicts: true,
    }];
    let inside = run(engine, sid, "SELECT id, name FROM tpm_it_owners").await;
    assert_eq!(
        inside.statements[0].editing.clone().unwrap().read_only[0].reason,
        "Commit or roll back the open transaction to edit results",
        "{driver:?}"
    );
    let err = engine.apply_change_sets(sid, &fresh, true).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::PolicyViolation, "{driver:?}: {err:?}");
    run(engine, sid, "ROLLBACK").await;
    let owner = run(engine, sid, &format!("SELECT name FROM tpm_it_owners WHERE id = {owner_id}")).await;
    assert_eq!(
        text(&owner.statements[0].rows.as_ref().unwrap()[0][0]),
        "renamed owner",
        "user's txn untouched ({driver:?})"
    );
    assert_eq!(engine.apply_change_sets(sid, &fresh, true).await.unwrap(), vec![1], "{driver:?}");

    // Only reads are described: a write's RETURNING columns get no origins (and no extra round trip).
    if driver == Driver::Postgres {
        let r = run(engine, sid, "INSERT INTO tpm_it_owners (id, name) VALUES (777, 'ret') RETURNING id, name").await;
        let st = &r.statements[0];
        assert!(st.columns.as_ref().unwrap().iter().all(|c| c.origin.is_none()), "{:?}", st.columns);
        assert!(st.editing.is_none());
        run(engine, sid, "DELETE FROM tpm_it_owners WHERE id = 777").await;
        // Column names are looked up per statement: a rename is followed, never a stale name.
        run(engine, sid, "SELECT id, name FROM tpm_it_owners").await;
        run(engine, sid, "ALTER TABLE tpm_it_owners RENAME COLUMN name TO label").await;
        let r = run(engine, sid, "SELECT id, label FROM tpm_it_owners").await;
        let origin = r.statements[0].columns.as_ref().unwrap()[1].origin.clone().unwrap();
        run(engine, sid, "ALTER TABLE tpm_it_owners RENAME COLUMN label TO name").await;
        assert_eq!(origin.column, "label");
    }

    // The adapter's own check, without the engine's BEGIN tracking.
    let mut raw = adapters::connect(profile, password, &ConnectOptions::default()).await.unwrap();
    assert!(!raw.in_transaction().await.unwrap(), "idle ({driver:?})");
    raw.execute("BEGIN", 10).await.unwrap();
    raw.execute("SELECT 1", 10).await.unwrap();
    // MySQL has no exact check; the engine's tracking of START TRANSACTION covers it (tested above).
    assert_eq!(raw.in_transaction().await.unwrap(), driver != Driver::Mysql, "after BEGIN ({driver:?})");
    raw.execute("ROLLBACK", 10).await.unwrap();
    assert!(!raw.in_transaction().await.unwrap(), "after ROLLBACK ({driver:?})");
    raw.close().await;

    // Origins name the table, not the alias: shapes where that is ambiguous stay read-only.
    let editing_of = |r: &tpm_core::engine::ScriptResult| r.statements[0].editing.clone().unwrap();
    let r = run(
        engine,
        sid,
        "SELECT a.id, a.name, b.name FROM tpm_it_items a LEFT JOIN tpm_it_items b ON b.id = a.owner_id",
    )
    .await;
    let e = editing_of(&r);
    assert!(e.tables.is_empty(), "self-join with one key ({driver:?}): {e:?}");
    assert!(
        e.read_only.iter().any(|x| x.reason.starts_with("tpm_it_items appears more than once")),
        "{driver:?}: {e:?}"
    );
    let r = run(engine, sid, "SELECT id, name FROM tpm_it_items UNION ALL SELECT id, name FROM tpm_it_owners").await;
    let e = editing_of(&r);
    assert!(e.tables.is_empty(), "union ({driver:?}): {e:?}");
    run(engine, sid, "CREATE VIEW tpm_it_items_v AS SELECT id, name FROM tpm_it_items").await;
    let r =
        run(engine, sid, "SELECT i.id, i.name, v.name FROM tpm_it_items i JOIN tpm_it_items_v v ON v.id = i.owner_id")
            .await;
    let e = editing_of(&r);
    assert_eq!(e.columns[2], None, "a view's column is never edited as its base table ({driver:?}): {e:?}");
    let r = run(engine, sid, "SELECT id, name FROM tpm_it_items_v").await;
    assert!(editing_of(&r).tables.is_empty(), "through a view ({driver:?})");
    run(engine, sid, "DROP VIEW tpm_it_items_v").await;

    // Missing key: no editable table, and a hint.
    let nokey = run(engine, sid, "SELECT name FROM tpm_it_owners").await;
    let e = nokey.statements[0].editing.clone().unwrap();
    assert!(e.tables.is_empty());
    assert_eq!(e.read_only[0].reason, "Add id to the SELECT to edit tpm_it_owners");

    // Read-only session: nothing is editable.
    let mut ro = profile.clone();
    ro.safety_mode = SafetyMode::ReadOnly;
    let info = engine.open_session(&ro, password, None, ConnectOptions::default()).await.expect("read-only connect");
    let r = run(engine, &info.session_id, "SELECT id, name FROM tpm_it_owners").await;
    assert_eq!(r.statements[0].editing.clone().unwrap().read_only[0].reason, "Read-only connection");
    assert!(engine.apply_change_sets(&info.session_id, &sets, true).await.is_err());
    engine.close_session(&info.session_id).await;
}

/// Each engine reports where result columns come from (DuckDB cannot).
async fn origins(engine: &Engine, sid: &str, driver: Driver) {
    let r = run(engine, sid, "SELECT i.id, i.name AS label, o.name, i.price * 2 AS doubled, count(*) OVER () AS n FROM tpm_it_items i JOIN tpm_it_owners o ON o.id = i.owner_id").await;
    let cols = r.statements[0].columns.clone().expect("columns");
    let tables: Vec<Option<(String, String)>> =
        cols.iter().map(|c| c.origin.as_ref().map(|o| (o.table.clone(), o.column.clone()))).collect();
    if driver == Driver::Duckdb {
        assert!(tables.iter().all(Option::is_none), "duckdb reports no origins: {tables:?}");
        return;
    }
    assert_eq!(tables[0], Some(("tpm_it_items".into(), "id".into())), "{driver:?}");
    assert_eq!(tables[1], Some(("tpm_it_items".into(), "name".into())), "aliased column keeps its origin ({driver:?})");
    assert_eq!(tables[2], Some(("tpm_it_owners".into(), "name".into())), "{driver:?}");
    assert_eq!(tables[3], None, "expression has no origin ({driver:?})");
    assert_eq!(tables[4], None, "window aggregate has no origin ({driver:?})");
}

/// Export a table to every format, then import the CSV back into a copy, all through the engine.
async fn transfer_roundtrip(engine: &Arc<Engine>, sid: &str, schema: &str, driver: Driver) {
    use tpm_core::transfer::{
        ColumnMapping, Encoding, ExportFormat, ExportOptions, ImportFormat, ImportOptions, open_sink,
    };
    let dir = tempfile::tempdir().unwrap();
    let base = BrowseRequest {
        schema: schema.into(),
        table: "tpm_it_items".into(),
        filter: None,
        sort: vec![],
        limit: 1,
        offset: 0,
        ..Default::default()
    };
    for (format, ext) in [
        (ExportFormat::Csv, "csv"),
        (ExportFormat::Json, "json"),
        (ExportFormat::JsonLines, "jsonl"),
        (ExportFormat::Sql, "sql"),
        (ExportFormat::Xlsx, "xlsx"),
    ] {
        let path = dir.path().join(format!("items.{ext}"));
        let opts = ExportOptions {
            format,
            delimiter: ',',
            header: true,
            null_text: String::new(),
            sql_table: Some("tpm_it_copy".into()),
            sql_schema: None,
            dialect: Some(driver.dialect()),
            sql_batch: 2,
        };
        let sink = open_sink(&path, &opts).unwrap();
        let n = engine.export_table(sid, &base, sink, None, Arc::new(Default::default())).await.unwrap();
        // 4 fixture rows plus "date" inserted by the pending-changes step.
        assert_eq!(n, 5, "{format:?}");
        assert!(std::fs::metadata(&path).unwrap().len() > 0);
    }

    // Import the CSV export into an empty copy of the table structure.
    let create = match driver {
        Driver::Postgres => {
            "CREATE TABLE tpm_it_copy (id integer, owner_id integer, name text NOT NULL, price numeric(10,2))"
        }
        Driver::Sqlite => "CREATE TABLE tpm_it_copy (id integer, owner_id integer, name text NOT NULL, price numeric)",
        _ => "CREATE TABLE tpm_it_copy (id int, owner_id int, name varchar(100) NOT NULL, price decimal(10,2))",
    };
    run(engine, sid, &format!("DROP TABLE IF EXISTS tpm_it_copy; {create}")).await;
    let opts = ImportOptions {
        format: ImportFormat::Csv,
        delimiter: ',',
        quote: '"',
        header: true,
        encoding: Encoding::Utf8,
        null_values: vec![String::new()],
        trim: false,
    };
    let preview = tpm_core::transfer::preview(&dir.path().join("items.csv"), &opts, 100).unwrap();
    let idx = |name: &str| preview.columns.iter().position(|c| c.name == name).unwrap();
    let mapping = ["id", "owner_id", "name", "price"]
        .iter()
        .map(|c| ColumnMapping { target: c.to_string(), source: idx(c) })
        .collect();
    let req = tpm_core::engine::ImportRequest {
        path: dir.path().join("items.csv").to_string_lossy().into_owned(),
        options: opts.clone(),
        schema: schema.into(),
        table: "tpm_it_copy".into(),
        mapping,
        skip: 0,
    };
    assert!(
        engine.import_file(sid, &req, false, None, Arc::new(Default::default())).await.is_err(),
        "needs confirmation"
    );
    let n = engine.import_file(sid, &req, true, None, Arc::new(Default::default())).await.unwrap();
    assert_eq!(n, 5);
    let r = run(engine, sid, "SELECT count(*), count(price) FROM tpm_it_copy").await;
    assert_eq!(text(&r.statements[0].rows.as_ref().unwrap()[0][0]), "5");
    let r = run(engine, sid, "SELECT count(*) FROM tpm_it_copy WHERE name = 'it''s; tricky' AND price IS NULL").await;
    assert_eq!(
        text(&r.statements[0].rows.as_ref().unwrap()[0][0]),
        "1",
        "quotes, semicolons and NULLs survive the round trip"
    );

    // A bad record rolls back the whole import (name is NOT NULL; the file has an empty name).
    let bad = dir.path().join("bad.csv");
    std::fs::write(&bad, "id,name\n100,ok\n101,\n").unwrap();
    let bad_req = tpm_core::engine::ImportRequest {
        path: bad.to_string_lossy().into_owned(),
        options: opts,
        schema: schema.into(),
        table: "tpm_it_copy".into(),
        mapping: vec![
            ColumnMapping { target: "id".into(), source: 0 },
            ColumnMapping { target: "name".into(), source: 1 },
        ],
        skip: 0,
    };
    let err = engine.import_file(sid, &bad_req, true, None, Arc::new(Default::default())).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Constraint, "{err:?}");
    let r = run(engine, sid, "SELECT count(*) FROM tpm_it_copy").await;
    assert_eq!(text(&r.statements[0].rows.as_ref().unwrap()[0][0]), "5", "failed import must roll back");

    // Exporting a stored query result.
    let r = run(engine, sid, "SELECT * FROM tpm_it_copy ORDER BY id").await;
    let path = dir.path().join("result.csv");
    let sink = open_sink(
        &path,
        &ExportOptions {
            format: ExportFormat::Csv,
            delimiter: ',',
            header: true,
            null_text: String::new(),
            sql_table: None,
            sql_schema: None,
            dialect: None,
            sql_batch: 100,
        },
    )
    .unwrap();
    assert_eq!(engine.export_result(r.statements[0].result_id.as_ref().unwrap(), sink).await.unwrap(), 5);
    assert_eq!(std::fs::read_to_string(&path).unwrap().lines().count(), 6);
    run(engine, sid, "DROP TABLE tpm_it_copy").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn postgres() {
    if let Some(t) = target_from_env("TPM_TEST_PG_URL") {
        exercise(t).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn mysql() {
    if let Some(t) = target_from_env("TPM_TEST_MYSQL_URL") {
        exercise(t).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn mariadb() {
    if let Some(t) = target_from_env("TPM_TEST_MARIADB_URL") {
        exercise(t).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn sqlite() {
    let dir = tempfile::tempdir().unwrap();
    exercise(sqlite_target(&dir)).await;
}

fn duckdb_target(dir: &tempfile::TempDir) -> Target {
    let path = dir.path().join("it.duckdb");
    adapters::duckdb::create_database_file(path.to_str().unwrap()).unwrap();
    let mut profile = ConnectionProfile::new("duckdb-it", Driver::Duckdb);
    profile.file_path = Some(path.to_string_lossy().into_owned());
    Target {
        profile,
        password: None,
        schema: "main".into(),
        sleep_sql: "SELECT count(*) FROM range(100000000000) a",
        big_query: "SELECT range AS v FROM range(1000000)".into(),
        sequence_write: Some("SELECT nextval('tpm_it_seq')"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn duckdb() {
    let dir = tempfile::tempdir().unwrap();
    exercise(duckdb_target(&dir)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn sqlite_open_rules() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("missing.db");
    let mut p = ConnectionProfile::new("x", Driver::Sqlite);
    p.file_path = Some(missing.to_string_lossy().into_owned());
    let err = match adapters::connect(&p, None, &ConnectOptions::default()).await {
        Err(e) => e,
        Ok(_) => panic!("opening a missing file must not create it"),
    };
    assert_eq!(err.kind, ErrorKind::File);
    assert!(!missing.exists());

    let not_db = dir.path().join("notes.txt");
    std::fs::write(&not_db, "hello, I am not a database file at all.......................").unwrap();
    p.file_path = Some(not_db.to_string_lossy().into_owned());
    assert!(adapters::connect(&p, None, &ConnectOptions::default()).await.is_err());

    let created = dir.path().join("new.db");
    adapters::sqlite::create_database_file(created.to_str().unwrap()).unwrap();
    assert!(adapters::sqlite::create_database_file(created.to_str().unwrap()).is_err(), "never overwrite");
    p.file_path = Some(created.to_string_lossy().into_owned());
    let mut s = adapters::connect(&p, None, &ConnectOptions::default()).await.unwrap();
    let out = s.execute("CREATE TABLE t (x)", 10).await.unwrap();
    assert!(matches!(out[0], StatementOutcome::Affected { .. }));
}

/// Production safety: a production connection can be opened locked to reads (the database session
/// refuses writes too), and statements that destroy data need the connection name typed.
#[tokio::test(flavor = "multi_thread")]
async fn production_safety() {
    use tpm_core::config::Environment;
    let dir = tempfile::tempdir().unwrap();
    let mut t = sqlite_target(&dir);
    t.profile.name = "Shop prod".into();
    t.profile.environment = Environment::Production;
    let engine = Engine::new();
    let locked = ConnectOptions { lock_production: true, ..Default::default() };

    // Locked: read-only, and the database session itself refuses writes.
    let info = engine.open_session(&t.profile, None, None, locked.clone()).await.unwrap();
    assert!(info.read_only && info.writes_locked, "{info:?}");
    let err = engine.run_script(&info.session_id, "CREATE TABLE t (x)", RunOptions::default(), None).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::PolicyViolation, "{err:?}");
    engine.close_session(&info.session_id).await;
    // Only production connections are locked.
    let mut dev = t.profile.clone();
    dev.environment = Environment::Development;
    let info = engine.open_session(&dev, None, None, locked).await.unwrap();
    assert!(!info.read_only && !info.writes_locked, "{info:?}");
    engine.close_session(&info.session_id).await;

    // Writes allowed: destroying data needs the connection name typed, not only a click.
    let info = engine.open_session(&t.profile, None, None, ConnectOptions::default()).await.unwrap();
    assert!(!info.read_only && !info.writes_locked);
    let sid = info.session_id.clone();
    run(&engine, &sid, "CREATE TABLE t (x); CREATE TABLE u (x); INSERT INTO t VALUES (1)").await;
    let opts = |confirmed: bool, typed: Option<&str>| RunOptions {
        confirmed,
        typed_confirmation: typed.map(str::to_string),
        ..Default::default()
    };
    for (confirmed, typed) in [(false, None), (true, None), (true, Some("shop prod")), (true, Some("Shop"))] {
        let err = engine.run_script(&sid, "DELETE FROM t", opts(confirmed, typed), None).await.unwrap_err();
        assert_eq!(err.kind, ErrorKind::ConfirmationRequired, "{typed:?}");
        assert_eq!(err.code.as_deref(), Some("confirm_typed"), "{typed:?}");
        assert!(err.detail.as_deref().unwrap_or("").contains("DELETE"), "{err:?}");
    }
    let r = engine.run_script(&sid, "DELETE FROM t", opts(true, Some(" Shop prod ")), None).await.unwrap();
    assert!(r.statements[0].error.is_none(), "{r:?}");
    // A change with a WHERE is confirmed with a click, as before.
    engine.run_script(&sid, "INSERT INTO t VALUES (2)", opts(false, None), None).await.unwrap();
    engine.run_script(&sid, "DELETE FROM t WHERE x = 2", opts(true, None), None).await.unwrap();

    // Reviewed DDL (sidebar Drop table, structure editor) too.
    let err = engine.apply_ddl(&sid, &["DROP TABLE u".to_string()], true, None).await.unwrap_err();
    assert_eq!(err.code.as_deref(), Some("confirm_typed"), "{err:?}");
    engine.apply_ddl(&sid, &["DROP TABLE u".to_string()], true, Some("Shop prod")).await.unwrap();
    engine.apply_ddl(&sid, &["CREATE TABLE v (x)".to_string()], true, None).await.unwrap();
    engine.close_session(&sid).await;

    // Elsewhere a click is enough.
    let info = engine.open_session(&dev, None, None, ConnectOptions::default()).await.unwrap();
    engine.run_script(&info.session_id, "DROP TABLE t", opts(true, None), None).await.unwrap();
    engine.close_session(&info.session_id).await;
}

/// Connecting reports its steps, and Cancel stops a connection attempt that would otherwise wait for
/// the timeout (a server that accepts the TCP connection and never answers).
#[tokio::test(flavor = "multi_thread")]
async fn connect_progress_and_cancel() {
    use std::sync::Mutex;
    use tpm_core::engine::ConnectStep;
    let engine = Arc::new(Engine::new());
    let steps = Arc::new(Mutex::new(Vec::new()));
    let record = |steps: &Arc<Mutex<Vec<ConnectStep>>>| {
        let steps = steps.clone();
        Arc::new(move |s: ConnectStep| steps.lock().unwrap().push(s)) as tpm_core::engine::ConnectStepFn
    };
    let dir = tempfile::tempdir().unwrap();
    let t = sqlite_target(&dir);
    let info = engine
        .open_session_tracked(&t.profile, None, None, ConnectOptions::default(), Some("c0"), Some(record(&steps)))
        .await
        .unwrap();
    assert_eq!(*steps.lock().unwrap(), vec![ConnectStep::Connect, ConnectStep::ServerInfo]);
    engine.close_session(&info.session_id).await;
    assert!(!engine.cancel_connect("c0"), "a finished connect is forgotten");

    // Cancel arrives before the attempt starts (the app still reading the keychain): it still counts.
    let reg = engine.prepare_connect("c2");
    assert!(engine.cancel_connect("c2"));
    let err = engine
        .open_session_tracked(&t.profile, None, None, ConnectOptions::default(), Some("c2"), None)
        .await
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::Cancelled);
    drop(reg);
    assert!(!engine.cancel_connect("c2"), "forgotten once the command is done");

    // A server that accepts and never answers.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let held = tokio::spawn(async move {
        let mut open = Vec::new();
        while let Ok((socket, _)) = listener.accept().await {
            open.push(socket);
        }
    });
    let mut profile = ConnectionProfile::new("hangs", Driver::Postgres);
    profile.host = "127.0.0.1".into();
    profile.port = Some(port);
    profile.user = "u".into();
    profile.database = "d".into();
    profile.connect_timeout_secs = 60;
    steps.lock().unwrap().clear();
    let (e2, p2, rec) = (engine.clone(), profile.clone(), record(&steps));
    let attempt = tokio::spawn(async move {
        e2.open_session_tracked(&p2, Some("pw"), None, ConnectOptions::default(), Some("c1"), Some(rec)).await
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    let t0 = Instant::now();
    assert!(engine.cancel_connect("c1"));
    let err = attempt.await.unwrap().unwrap_err();
    assert_eq!(err.kind, ErrorKind::Cancelled, "{err:?}");
    assert!(t0.elapsed() < Duration::from_secs(2), "{:?}", t0.elapsed());
    assert_eq!(*steps.lock().unwrap(), vec![ConnectStep::Connect]);

    // Without Cancel, the connection's timeout covers a server that never answers (the driver's
    // own timeout covers only the TCP connection).
    profile.connect_timeout_secs = 1;
    let t0 = Instant::now();
    let err = engine.open_session(&profile, Some("pw"), None, ConnectOptions::default()).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Timeout, "{err:?}");
    assert!(t0.elapsed() < Duration::from_secs(3), "{:?}", t0.elapsed());
    assert!(err.message.contains("1s"), "{}", err.message);
    held.abort();
}

/// DuckDB opens one instance per file, read-only or writable: a production file locked to reads is
/// opened writable underneath (the policy refuses writes), so Allow writes can open it too.
#[tokio::test(flavor = "multi_thread")]
async fn production_lock_on_duckdb() {
    use tpm_core::config::Environment;
    let dir = tempfile::tempdir().unwrap();
    let mut t = duckdb_target(&dir);
    t.profile.environment = Environment::Production;
    let engine = Engine::new();
    let locked = ConnectOptions { lock_production: true, ..Default::default() };
    let ro = engine.open_session(&t.profile, None, None, locked).await.unwrap();
    assert!(ro.read_only && ro.writes_locked);
    let err = engine.run_script(&ro.session_id, "CREATE TABLE t (x INTEGER)", RunOptions::default(), None).await;
    assert_eq!(err.unwrap_err().kind, ErrorKind::PolicyViolation);
    // Allow writes while the locked session (and its query tabs) are still open.
    let rw = engine.open_session(&t.profile, None, None, ConnectOptions::default()).await.unwrap();
    run(&engine, &rw.session_id, "CREATE TABLE t (x INTEGER)").await;
    engine.close_session(&rw.session_id).await;
    // A reconnect of the locked session keeps it locked, and keeps the file shareable.
    let again = engine.reconnect(&ro.session_id, None, None).await.unwrap();
    assert!(again.read_only && again.writes_locked);
    let err = engine.run_script(&ro.session_id, "DROP TABLE t", RunOptions::default(), None).await;
    assert_eq!(err.unwrap_err().kind, ErrorKind::PolicyViolation);
    let rw = engine.open_session(&t.profile, None, None, ConnectOptions::default()).await.unwrap();
    engine.close_session(&rw.session_id).await;
    engine.close_session(&ro.session_id).await;
}

/// The engine's own SQLite transactions (restore-point captures, grid commits, imports) read and
/// then write, so they take the write lock up front: a deferred BEGIN can fail on its first write
/// with SQLITE_BUSY_SNAPSHOT when another connection wrote in between (WAL mode).
#[tokio::test(flavor = "multi_thread")]
async fn sqlite_begin_takes_the_write_lock() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lock.db");
    adapters::sqlite::create_database_file(path.to_str().unwrap()).unwrap();
    let other = rusqlite::Connection::open(&path).unwrap();
    other.busy_timeout(Duration::ZERO).unwrap();
    other.execute_batch("PRAGMA journal_mode = WAL; CREATE TABLE t (x)").unwrap();
    let mut p = ConnectionProfile::new("x", Driver::Sqlite);
    p.file_path = Some(path.to_string_lossy().into_owned());
    let mut s = adapters::connect(&p, None, &ConnectOptions::default()).await.unwrap();
    s.begin().await.unwrap();
    let err = other.execute("INSERT INTO t VALUES (1)", []).expect_err("another writer must wait for us");
    assert_eq!(err.sqlite_error_code(), Some(rusqlite::ErrorCode::DatabaseBusy), "{err}");
    s.rollback().await.unwrap();
    other.execute("INSERT INTO t VALUES (1)", []).unwrap();
}

/// SSH tunnel to PostgreSQL through the disposable bastion from `scripts/test-db.sh`.
#[tokio::test(flavor = "multi_thread")]
async fn ssh_tunnel() {
    use tpm_core::config::PasswordMode;
    use tpm_core::ssh::{SshAuth, SshConfig};
    let (Ok(ssh), Ok(pg_url)) = (std::env::var("TPM_TEST_SSH"), std::env::var("TPM_TEST_PG_URL")) else {
        eprintln!("BLOCKED: TPM_TEST_SSH / TPM_TEST_PG_URL not set; run scripts/test-db.sh up");
        return;
    };
    let parts: Vec<&str> = ssh.splitn(4, ':').collect();
    let (ssh_host, ssh_port, ssh_user, ssh_pass) = (parts[0], parts[1].parse::<u16>().unwrap(), parts[2], parts[3]);
    let parsed = parse_connection_url(&pg_url).unwrap();
    let mut profile = parsed.profile.clone();
    // The bastion reaches PostgreSQL by its container name on the private network.
    profile.host = "tpm-test-postgres".into();
    profile.port = Some(5432);
    profile.ssh = Some(SshConfig {
        host: ssh_host.into(),
        port: ssh_port,
        user: ssh_user.into(),
        auth: SshAuth::Password,
        key_path: None,
        secret_mode: PasswordMode::Ask,
    });
    let dir = tempfile::tempdir().unwrap();
    let engine = Arc::new(Engine::with_known_hosts(dir.path().join("known_hosts")));
    let pw = parsed.password.as_deref();

    // 1. Unknown host keys are refused, with the fingerprint and key to review.
    let err = engine.open_session(&profile, pw, Some(ssh_pass), ConnectOptions::default()).await.unwrap_err();
    assert_eq!(err.code.as_deref(), Some("ssh_unknown_host"), "{err:?}");
    let detail = err.detail.clone().unwrap();
    assert!(detail.starts_with("SHA256:"), "{detail}");
    let key_line = detail.lines().nth(1).unwrap().to_string();

    // 2. After the user trusts it, queries run through the tunnel.
    engine.trust_ssh_host(ssh_host, ssh_port, &key_line).unwrap();
    let steps = Arc::new(std::sync::Mutex::new(Vec::new()));
    let rec = steps.clone();
    let on_step: tpm_core::engine::ConnectStepFn = Arc::new(move |s| rec.lock().unwrap().push(s));
    let info = engine
        .open_session_tracked(&profile, pw, Some(ssh_pass), ConnectOptions::default(), Some("ssh-1"), Some(on_step))
        .await
        .expect("tunnel");
    {
        use tpm_core::engine::ConnectStep::*;
        assert_eq!(*steps.lock().unwrap(), vec![Tunnel, Connect, ServerInfo]);
    }
    let r = run(&engine, &info.session_id, "SELECT inet_server_addr()::text IS NOT NULL, current_database()").await;
    assert_eq!(text(&r.statements[0].rows.as_ref().unwrap()[0][1]), "tpm_test");

    // Protocol-level cancel requests also travel through the tunnel.
    let e2 = engine.clone();
    let sid = info.session_id.clone();
    let h = tokio::spawn(async move {
        e2.run_script(
            &sid,
            "SELECT pg_sleep(30)",
            RunOptions { task_id: Some("ssh-cancel".into()), ..Default::default() },
            None,
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(700)).await;
    let t0 = Instant::now();
    assert!(engine.cancel_task("ssh-cancel").await.unwrap());
    let r = h.await.unwrap().unwrap();
    assert_eq!(r.statements[0].error.as_ref().unwrap().kind, ErrorKind::Cancelled);
    assert!(t0.elapsed() < Duration::from_secs(5));
    engine.close_session(&info.session_id).await;

    // 3. Wrong SSH password.
    let err = engine.open_session(&profile, pw, Some("wrong"), ConnectOptions::default()).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Authentication, "{err:?}");

    // 4. Key authentication.
    if let Ok(key) = std::env::var("TPM_TEST_SSH_KEY") {
        let mut keyed = profile.clone();
        let ssh = keyed.ssh.as_mut().unwrap();
        ssh.auth = SshAuth::Key;
        ssh.key_path = Some(key);
        let info = engine.open_session(&keyed, pw, None, ConnectOptions::default()).await.expect("key auth");
        run(&engine, &info.session_id, "SELECT 1").await;
        engine.close_session(&info.session_id).await;
    } else {
        eprintln!("BLOCKED: TPM_TEST_SSH_KEY not set; key authentication not tested");
    }

    // 5. A changed host key is refused even though the host is known.
    std::fs::write(
        dir.path().join("known_hosts"),
        format!(
            "[{ssh_host}]:{ssh_port} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICUtoQQEaySZOV0R/7zfnpNsCLIQvMNHD75/6mGHpRiJ\n"
        ),
    )
    .unwrap();
    let err = engine.open_session(&profile, pw, Some(ssh_pass), ConnectOptions::default()).await.unwrap_err();
    assert!(
        matches!(err.code.as_deref(), Some("ssh_host_key_changed") | Some("ssh_unknown_host")),
        "a mismatched key must never connect: {err:?}"
    );
}

/// Redis key browser and console against the disposable server (database 15 only).
#[tokio::test(flavor = "multi_thread")]
async fn redis_kv() {
    use tpm_core::redis_kv::{RedisValue, parse_command_line};
    let Ok(url) = std::env::var("TPM_TEST_REDIS_URL") else {
        eprintln!("BLOCKED: TPM_TEST_REDIS_URL not set; run scripts/test-db.sh up");
        return;
    };
    let mut profile = parse_connection_url(&url).unwrap().profile;
    profile.safety_mode = SafetyMode::ConfirmDestructive;
    let engine = Engine::new();
    let (id, info) = engine.redis_open(&profile, None, None).await.expect("connect");
    assert!(!info.version.is_empty());
    assert_eq!(info.db, 15, "connected to the test database");
    let s = engine.redis(&id).unwrap();
    let mut s = s.lock().await;
    let run = |line: &str| parse_command_line(line).unwrap();

    // FLUSHDB is dangerous: it needs confirmation, then clears only database 15.
    let err = s.command(&run("FLUSHDB"), false, 10).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::ConfirmationRequired);
    s.command(&run("FLUSHDB"), true, 10).await.unwrap();

    for line in [
        "SET tpm:str \"hello world\"",
        "HSET tpm:hash name Ada lang Rust",
        "RPUSH tpm:list a b c",
        "SADD tpm:set x y",
        "ZADD tpm:zset 1 one 2 two",
        "XADD tpm:stream * temp 21.5",
        "SET other:key 1",
    ] {
        s.command(&run(line), false, 10).await.unwrap();
    }
    assert_eq!(s.command(&run("GET tpm:str"), false, 10).await.unwrap(), "\"hello world\"");
    assert_eq!(s.command(&run("LRANGE tpm:list 0 -1"), false, 10).await.unwrap(), "1) \"a\"\n2) \"b\"\n3) \"c\"");

    // SCAN with a pattern returns keys with their types and TTLs.
    let mut keys = Vec::new();
    let mut cursor = "0".to_string();
    loop {
        let page = s.scan(&cursor, "tpm:*", 100).await.unwrap();
        keys.extend(page.keys);
        cursor = page.cursor;
        if cursor == "0" {
            break;
        }
    }
    keys.sort_by(|a, b| a.key.cmp(&b.key));
    let kinds: Vec<(&str, &str)> = keys.iter().map(|k| (k.key.as_str(), k.kind.as_str())).collect();
    assert_eq!(
        kinds,
        [
            ("tpm:hash", "hash"),
            ("tpm:list", "list"),
            ("tpm:set", "set"),
            ("tpm:str", "string"),
            ("tpm:stream", "stream"),
            ("tpm:zset", "zset")
        ]
    );

    // Type-aware reads.
    assert!(
        matches!(s.read("tpm:str").await.unwrap(), RedisValue::String { ref value, length: 11, .. } if value == "hello world")
    );
    match s.read("tpm:hash").await.unwrap() {
        RedisValue::Hash { fields, length } => {
            assert_eq!(length, 2);
            assert!(fields.contains(&("name".into(), "Ada".into())));
        }
        v => panic!("{v:?}"),
    }
    assert!(
        matches!(s.read("tpm:zset").await.unwrap(), RedisValue::Zset { ref items, .. } if items[1] == ("two".to_string(), 2.0))
    );
    assert!(matches!(s.read("tpm:stream").await.unwrap(), RedisValue::Stream { length: 1, .. }));
    assert!(matches!(s.read("tpm:missing").await.unwrap(), RedisValue::None));

    // Edits and TTLs.
    s.set_string("tpm:str", "changed", true).await.unwrap();
    s.hash_set("tpm:hash", "lang", "Rust 2024").await.unwrap();
    s.hash_delete("tpm:hash", "name").await.unwrap();
    s.expire("tpm:list", Some(100)).await.unwrap();
    let page = s.scan("0", "tpm:list", 1000).await.unwrap();
    assert!(page.keys.iter().any(|k| k.key == "tpm:list" && k.ttl > 0));
    s.expire("tpm:list", None).await.unwrap();
    assert!(s.delete("tpm:set").await.unwrap());
    assert!(matches!(s.read("tpm:set").await.unwrap(), RedisValue::None));

    // Blocking commands are refused before reaching the server.
    assert_eq!(s.command(&run("BLPOP q 0"), true, 10).await.unwrap_err().kind, ErrorKind::PolicyViolation);
    drop(s);

    // Read-only connections only run read commands.
    let mut ro = profile.clone();
    ro.safety_mode = SafetyMode::ReadOnly;
    let (ro_id, _) = engine.redis_open(&ro, None, None).await.unwrap();
    let r = engine.redis(&ro_id).unwrap();
    let mut r = r.lock().await;
    assert_eq!(r.command(&run("GET tpm:str"), false, 10).await.unwrap(), "\"changed\"");
    assert_eq!(r.command(&run("SET tpm:str x"), true, 10).await.unwrap_err().kind, ErrorKind::PolicyViolation);
    assert_eq!(r.command(&run("FLUSHALL"), true, 10).await.unwrap_err().kind, ErrorKind::PolicyViolation);
    assert_eq!(r.set_string("tpm:str", "x", false).await.unwrap_err().kind, ErrorKind::PolicyViolation);
    assert_eq!(r.delete("tpm:str").await.unwrap_err().kind, ErrorKind::PolicyViolation);
    drop(r);

    let s = engine.redis(&id).unwrap();
    s.lock().await.command(&run("FLUSHDB"), true, 10).await.unwrap();
    engine.redis_close(&id);
    engine.redis_close(&ro_id);
}

/// SQL Server: a flow of its own, since its batches, types and paging differ from the others'.
#[tokio::test(flavor = "multi_thread")]
async fn sql_server() {
    let Some(t) = target_from_env("TPM_TEST_MSSQL_URL") else { return };
    sql_server_flow(t).await;
}

async fn sql_server_flow(t: Target) {
    let driver = Driver::Mssql;
    let mut profile = t.profile.clone();
    profile.safety_mode = SafetyMode::ConfirmDestructive;
    let engine = Arc::new(Engine::new());
    let info = engine.open_session(&profile, t.password.as_deref(), None, ConnectOptions::default()).await.unwrap();
    let sid = info.session_id.clone();
    assert_eq!(info.server.product, "SQL Server");
    assert_eq!(info.server.current_database, "tpm_test");
    let rows = |r: &tpm_core::engine::ScriptResult, i: usize| r.statements[i].rows.clone().unwrap();

    // --- fixtures ---
    let script = ddl(driver).join(";\n");
    let err = engine.run_script(&sid, &script, RunOptions::default(), None).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::ConfirmationRequired);
    run(&engine, &sid, &script).await;
    run(
        &engine,
        &sid,
        "INSERT INTO tpm_it_owners (id, name) VALUES (1, N'Ada'), (2, N'Grace');
         INSERT INTO tpm_it_items (owner_id, name, price, data, tags) VALUES
           (1, N'apple', 1.50, 0xDEADBEEF, N'{\"a\": 1}'), (1, N'banana', 0.25, NULL, NULL),
           (2, N'cherry', 12.00, NULL, NULL), (NULL, N'it''s; tricky', NULL, NULL, NULL)",
    )
    .await;

    // --- discovery ---
    assert!(engine.list_schemas(&sid).await.unwrap().contains(&"dbo".to_string()));
    let objects = engine.list_objects(&sid, "dbo").await.unwrap();
    let items = objects.iter().find(|o| o.name == "tpm_it_items").expect("listed");
    assert_eq!((items.kind, items.estimated_rows), (ObjectKind::Table, Some(4)));
    let st = engine.table_structure(&sid, "dbo", "tpm_it_items", true).await.unwrap();
    assert_eq!(st.columns.len(), 7);
    assert_eq!(st.primary_key()[0].name, "id");
    assert!(st.columns[0].auto_increment);
    assert!(!st.column("name").unwrap().nullable);
    assert_eq!(st.column("name").unwrap().data_type, "nvarchar(100)");
    assert_eq!(st.column("price").unwrap().data_type, "decimal(10,2)");
    assert_eq!(st.column("data").unwrap().data_type, "varbinary(max)");
    assert!(st.indexes.iter().any(|i| i.columns == ["price"]), "{:?}", st.indexes);
    assert_eq!(st.foreign_keys.len(), 1);
    assert_eq!(st.foreign_keys[0].ref_table, "tpm_it_owners");
    assert!(st.constraints.iter().any(|c| c.kind == "unique"), "{:?}", st.constraints);
    let def = engine.object_definition(&sid, "dbo", "tpm_it_items", ObjectKind::Table).await.unwrap();
    assert!(
        def.contains("CREATE TABLE [dbo].[tpm_it_items]") && def.contains("[id] int IDENTITY(1, 1) NOT NULL"),
        "{def}"
    );
    let dbs = engine.list_databases(&sid).await.unwrap();
    assert_eq!(dbs.first().map(String::as_str), Some("tpm_test"), "user databases first: {dbs:?}");

    // --- a batch: result sets in order, values as text, binary as bytes ---
    let r = run(&engine, &sid, "SELECT id, name, price, data FROM tpm_it_items ORDER BY id; SELECT 1 + 1 AS two").await;
    assert_eq!(r.statements.len(), 2, "one batch, two result sets");
    let rs = rows(&r, 0);
    assert_eq!(rs.len(), 4);
    assert_eq!(text(&rs[0][1]), "apple");
    assert_eq!(text(&rs[0][2]), "1.50");
    assert_eq!(rs[0][3], Cell::Bytes(vec![0xde, 0xad, 0xbe, 0xef]));
    assert_eq!(rs[1][3], Cell::Null);
    assert_eq!(text(&rs[3][1]), "it's; tricky");
    assert_eq!(text(&rows(&r, 1)[0][0]), "2");
    // Variables live for the whole batch; GO starts the next one.
    let r = run(&engine, &sid, "DECLARE @x int = 41;\nSELECT @x + 1 AS v").await;
    assert_eq!(text(&rows(&r, 0)[0][0]), "42");
    let r = run(&engine, &sid, "SELECT 1 AS a\nGO\nSELECT 2 AS b").await;
    assert_eq!((r.statements.len(), text(&rows(&r, 1)[0][0])), (2, "2"));
    let r = run(&engine, &sid, "UPDATE tpm_it_items SET tags = NULL WHERE price < 1").await;
    assert_eq!(r.statements[0].rows_affected, Some(1));

    // --- errors: the position points into the script; constraint errors are classified ---
    let r = engine
        .run_script(
            &sid,
            "SELECT 1\nGO\nSELECT 1;\n  SELEC oops",
            RunOptions { confirmed: true, ..Default::default() },
            None,
        )
        .await
        .unwrap();
    let e = r.statements.last().unwrap().error.as_ref().expect("syntax error");
    assert_eq!(e.position, Some(24), "{e:?}");
    let r = engine
        .run_script(&sid, "INSERT INTO tpm_it_items (name) VALUES (N'apple')", RunOptions::default(), None)
        .await
        .unwrap();
    assert_eq!(r.statements[0].error.as_ref().unwrap().kind, ErrorKind::Constraint);

    // --- browse: filter, sort, pagination, count ---
    let cond = |column: &str, op: FilterOp, value: &str| FilterNode::Condition {
        column: column.into(),
        op,
        value: Some(value.into()),
        value2: None,
        values: vec![],
        enabled: true,
    };
    let req = BrowseRequest {
        schema: "dbo".into(),
        table: "tpm_it_items".into(),
        filter: Some(FilterNode::Group {
            logic: Logic::Or,
            negate: false,
            children: vec![cond("price", FilterOp::Gte, "1"), cond("name", FilterOp::Contains, "; TRICK")],
        }),
        sort: vec![SortSpec { column: "name".into(), descending: true }],
        limit: 2,
        offset: 0,
        ..Default::default()
    };
    let page = engine.browse(&sid, &req).await.unwrap();
    assert_eq!(page.rows.iter().map(|r| text(&r[2])).collect::<Vec<_>>(), ["it's; tricky", "cherry"]);
    assert!(page.has_more);
    let page2 = engine.browse(&sid, &BrowseRequest { offset: 2, ..req.clone() }).await.unwrap();
    assert_eq!((page2.rows.len(), page2.has_more), (1, false));
    assert_eq!(engine.count_rows(&sid, "dbo", "tpm_it_items", req.filter.as_ref()).await.unwrap(), 3);
    let evil = BrowseRequest { filter: Some(cond("name", FilterOp::Eq, "x' OR '1'='1")), ..req.clone() };
    assert!(engine.browse(&sid, &evil).await.unwrap().rows.is_empty());
    let brackets = BrowseRequest { filter: Some(cond("name", FilterOp::Contains, "[a]")), ..req.clone() };
    assert!(engine.browse(&sid, &brackets).await.unwrap().rows.is_empty(), "[ is literal in a contains filter");

    // --- grid edits: one transaction, conflicts, rollback ---
    let apple_req = BrowseRequest { filter: Some(cond("name", FilterOp::Eq, "apple")), ..req.clone() };
    let apple = engine.browse(&sid, &apple_req).await.unwrap();
    let apple_id = text(&apple.rows[0][0]).to_string();
    let apple_price = apple.rows[0][3].as_text().map(str::to_string);
    let key = |id: &str| vec![ColumnValue { column: "id".into(), value: Some(id.into()) }];
    let set = ChangeSet {
        schema: "dbo".into(),
        table: "tpm_it_items".into(),
        check_conflicts: true,
        changes: vec![
            RowChange::Update {
                key: key(&apple_id),
                edits: vec![ColumnEdit {
                    column: "price".into(),
                    value: EditValue::Value { value: Some("2.75".into()) },
                    original: Some(apple_price.clone()),
                }],
            },
            RowChange::Insert {
                values: vec![
                    ColumnEdit { column: "id".into(), value: EditValue::Default, original: None },
                    ColumnEdit {
                        column: "name".into(),
                        value: EditValue::Value { value: Some("date".into()) },
                        original: None,
                    },
                    ColumnEdit {
                        column: "owner_id".into(),
                        value: EditValue::Value { value: Some("2".into()) },
                        original: None,
                    },
                ],
            },
        ],
    };
    assert!(engine.preview_changes(&sid, &set).await.unwrap().sql.contains("N'2.75'"));
    assert_eq!(engine.apply_changes(&sid, &set, true).await.unwrap(), vec![1, 1]);
    let r = run(&engine, &sid, "SELECT price FROM tpm_it_items WHERE name = N'apple'").await;
    assert_eq!(text(&rows(&r, 0)[0][0]), "2.75");
    let stale = ChangeSet {
        changes: vec![
            RowChange::Insert {
                values: vec![ColumnEdit {
                    column: "name".into(),
                    value: EditValue::Value { value: Some("should-roll-back".into()) },
                    original: None,
                }],
            },
            RowChange::Update {
                key: key(&apple_id),
                edits: vec![ColumnEdit {
                    column: "price".into(),
                    value: EditValue::Value { value: Some("9.99".into()) },
                    original: Some(apple_price),
                }],
            },
        ],
        ..set.clone()
    };
    assert_eq!(engine.apply_changes(&sid, &stale, true).await.unwrap_err().kind, ErrorKind::Conflict);
    let r = run(&engine, &sid, "SELECT count(*) FROM tpm_it_items WHERE name = N'should-roll-back'").await;
    assert_eq!(text(&rows(&r, 0)[0][0]), "0", "the transaction rolls back");

    // --- the row cap: a plain SELECT is capped by the server; a batch is stopped ---
    for (label, sql) in [("plain", t.big_query.clone()), ("batch", format!("DECLARE @n int = 1;\n{}", t.big_query))] {
        let t0 = Instant::now();
        let r = engine
            .run_script(&sid, &sql, RunOptions { max_rows: Some(100_000), ..Default::default() }, None)
            .await
            .unwrap();
        let s = &r.statements[0];
        assert!(s.error.is_none(), "{label}: {:?}", s.error);
        assert_eq!((s.total_rows, s.truncated), (Some(100_000), true), "{label}");
        eprintln!("{label}: 1M rows capped at 100k in {:?}", t0.elapsed());
        assert!(t0.elapsed() < Duration::from_secs(20), "{label}: {:?}", t0.elapsed());
        run(&engine, &sid, "SELECT 1").await;
    }
    // The cap's SET ROWCOUNT does not outlive the statement.
    let r = run(&engine, &sid, "SELECT TOP 3 name FROM sys.all_objects").await;
    assert_eq!(rows(&r, 0).len(), 3);
    let r = engine
        .run_script(
            &sid,
            "SELECT TOP 5 name FROM sys.all_objects",
            RunOptions { max_rows: Some(2), ..Default::default() },
            None,
        )
        .await
        .unwrap();
    assert_eq!(r.statements[0].total_rows, Some(2));
    let r = run(&engine, &sid, "SELECT TOP 5 name FROM sys.all_objects").await;
    assert_eq!(rows(&r, 0).len(), 5, "ROWCOUNT was reset");

    // --- cancel and timeout ---
    let e2 = engine.clone();
    let sid2 = sid.clone();
    let sleep_sql = t.sleep_sql.to_string();
    let handle = tokio::spawn(async move {
        e2.run_script(&sid2, &sleep_sql, RunOptions { task_id: Some("ms-cancel".into()), ..Default::default() }, None)
            .await
    });
    tokio::time::sleep(Duration::from_millis(700)).await;
    let t0 = Instant::now();
    assert!(engine.cancel_task("ms-cancel").await.unwrap());
    let r = handle.await.unwrap().unwrap();
    assert!(t0.elapsed() < Duration::from_secs(5), "cancel took {:?}", t0.elapsed());
    assert!(r.cancelled);
    assert_eq!(r.statements[0].error.as_ref().unwrap().kind, ErrorKind::Cancelled);
    run(&engine, &sid, "SELECT 1").await;
    let t0 = Instant::now();
    let r = engine
        .run_script(&sid, t.sleep_sql, RunOptions { timeout_secs: Some(1), ..Default::default() }, None)
        .await
        .unwrap();
    assert_eq!(r.statements[0].error.as_ref().unwrap().kind, ErrorKind::Timeout);
    assert!(t0.elapsed() < Duration::from_secs(6));
    run(&engine, &sid, "SELECT 1").await;
    assert_eq!(engine.explain(&sid, "SELECT 1", false, false, None).await.unwrap_err().kind, ErrorKind::Unsupported);

    // --- transactions the user opens are followed ---
    run(&engine, &sid, "BEGIN TRANSACTION; UPDATE tpm_it_items SET price = 3 WHERE name = N'cherry'").await;
    let err = engine.apply_changes(&sid, &set, true).await.unwrap_err();
    assert!(err.message.to_lowercase().contains("transaction"), "grid commits wait for the open transaction: {err:?}");
    run(&engine, &sid, "ROLLBACK").await;
    let r = run(&engine, &sid, "SELECT price FROM tpm_it_items WHERE name = N'cherry'").await;
    assert_eq!(text(&rows(&r, 0)[0][0]), "12.00");

    // --- read-only: the policy refuses writes, and the server keeps none of an unparsed batch ---
    let mut ro = t.profile.clone();
    ro.safety_mode = SafetyMode::ReadOnly;
    let ro_info = engine.open_session(&ro, t.password.as_deref(), None, ConnectOptions::default()).await.unwrap();
    let err = engine
        .run_script(
            &ro_info.session_id,
            "DELETE FROM tpm_it_items WHERE id = 1",
            RunOptions { confirmed: true, ..Default::default() },
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::PolicyViolation);
    run(&engine, &ro_info.session_id, "SELECT count(*) FROM tpm_it_items").await;
    let mut raw = adapters::connect(&ro, t.password.as_deref(), &ConnectOptions::default()).await.unwrap();
    let _ = raw.execute("INSERT INTO tpm_it_owners (id, name) VALUES (99, N'nope')", 10).await;
    raw.close().await;
    let r = run(&engine, &sid, "SELECT count(*) FROM tpm_it_owners WHERE id = 99").await;
    assert_eq!(text(&rows(&r, 0)[0][0]), "0", "a read-only session keeps no write");
    engine.close_session(&ro_info.session_id).await;

    // --- a lost connection is reported, and reconnecting works ---
    let victim = engine.open_session(&profile, t.password.as_deref(), None, ConnectOptions::default()).await.unwrap();
    let r = run(&engine, &victim.session_id, "SELECT @@SPID").await;
    let spid = text(&rows(&r, 0)[0][0]).to_string();
    run(&engine, &sid, &format!("KILL {spid}")).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let r = engine.run_script(&victim.session_id, "SELECT 1", RunOptions::default(), None).await.unwrap();
    assert!(matches!(r.statements[0].error.as_ref().map(|e| e.kind), Some(ErrorKind::Network | ErrorKind::Database)));
    engine.reconnect(&victim.session_id, t.password.as_deref(), None).await.unwrap();
    run(&engine, &victim.session_id, "SELECT 1").await;
    engine.close_session(&victim.session_id).await;

    // --- query parameters ---
    let mut values = std::collections::HashMap::new();
    values.insert("min".to_string(), Some("1".to_string()));
    let r = engine
        .run_script(
            &sid,
            "SELECT name FROM tpm_it_items WHERE price >= :min ORDER BY name",
            RunOptions { parameters: Some(values), ..Default::default() },
            None,
        )
        .await
        .unwrap();
    let names: Vec<String> = rows(&r, 0).iter().map(|r| text(&r[0]).to_string()).collect();
    assert_eq!(names, ["apple", "cherry"]);

    // --- origins: query results can be edited ---
    let r = run(&engine, &sid, "SELECT id, name FROM tpm_it_items").await;
    let origin = r.statements[0].columns.as_ref().unwrap()[1].origin.clone().expect("origin");
    assert_eq!(
        (origin.schema.as_str(), origin.table.as_str(), origin.column.as_str()),
        ("dbo", "tpm_it_items", "name")
    );

    // --- types: exact text, which also binds back as a parameter equal to the value ---
    let cases = [
        ("CAST('2024-01-02T03:04:05.123' AS datetime)", "2024-01-02 03:04:05.123"),
        ("CAST('2024-01-02T03:04:05.127' AS datetime)", "2024-01-02 03:04:05.127"),
        ("CAST('2024-01-02T03:04:00' AS smalldatetime)", "2024-01-02 03:04:00"),
        ("CAST('2024-01-02T03:04:05.1234567' AS datetime2)", "2024-01-02 03:04:05.1234567"),
        ("CAST('2024-01-02T03:04:05' AS datetime2(0))", "2024-01-02 03:04:05"),
        ("CAST('0001-01-01' AS date)", "0001-01-01"),
        ("CAST('9999-12-31' AS date)", "9999-12-31"),
        ("CAST('23:59:59.123' AS time(3))", "23:59:59.123"),
        ("CAST('2024-01-02T23:30:00+05:30' AS datetimeoffset(0))", "2024-01-02 23:30:00 +05:30"),
        ("CAST('2024-01-02T00:30:00.5-08:00' AS datetimeoffset(1))", "2024-01-02 00:30:00.5 -08:00"),
        ("CAST(12.5 AS money)", "12.5000"),
        ("CAST(-922337203.6854 AS money)", "-922337203.6854"),
        ("CAST(1.25 AS smallmoney)", "1.2500"),
        ("CAST(1 AS bit)", "1"),
        ("CAST('6F9619FF-8B86-D011-B42D-00C04FC964FF' AS uniqueidentifier)", "6F9619FF-8B86-D011-B42D-00C04FC964FF"),
        ("CAST(12345678901234567890.1234567890 AS decimal(38,10))", "12345678901234567890.1234567890"),
        ("CAST(-0.5 AS decimal(5,2))", "-0.50"),
        ("CAST(0.1 AS float)", "0.1"),
        ("CAST(255 AS tinyint)", "255"),
        ("CAST(9223372036854775807 AS bigint)", "9223372036854775807"),
        ("N'héllo 漢字 😀'", "héllo 漢字 😀"),
        ("CAST('ab' AS char(4))", "ab  "),
    ];
    for (expr, expected) in cases {
        let r = run(&engine, &sid, &format!("SELECT {expr} AS v")).await;
        assert_eq!(text(&rows(&r, 0)[0][0]), expected, "{expr}");
        let mut values = std::collections::HashMap::new();
        values.insert("v".to_string(), Some(expected.to_string()));
        let r = engine
            .run_script(
                &sid,
                &format!("SELECT CASE WHEN {expr} = :v THEN 'same' ELSE 'different' END"),
                RunOptions { parameters: Some(values), ..Default::default() },
                None,
            )
            .await
            .unwrap();
        assert!(r.statements[0].error.is_none(), "{expr}: {:?}", r.statements[0].error);
        assert_eq!(text(&rows(&r, 0)[0][0]), "same", "{expr} = '{expected}' as a parameter");
    }
    let r = run(&engine, &sid, "SELECT CAST('<a x=\"1\"/>' AS xml) AS x, CAST(NULL AS int) AS n").await;
    assert_eq!((text(&rows(&r, 0)[0][0]), &rows(&r, 0)[0][1]), ("<a x=\"1\"/>", &Cell::Null));

    // --- restore points: a DELETE is captured and comes back ---
    let store = Arc::new(tpm_core::storage::Storage::open_in_memory().unwrap());
    engine.set_restore_store(store.clone());
    let r = engine
        .run_script(
            &sid,
            "DELETE FROM tpm_it_items WHERE name = N'banana'",
            RunOptions { confirmed: true, ..Default::default() },
            None,
        )
        .await
        .unwrap();
    let note = r.statements[0].restore.clone().expect("note");
    assert_eq!(note.reason.as_deref(), Some("the table has binary columns"), "as on MySQL: {note:?}");
    run(&engine, &sid, "INSERT INTO tpm_it_items (owner_id, name, price) VALUES (1, N'banana', 0.25)").await;
    restore_points_on_sql_server(&engine, &sid).await;

    transfer_roundtrip(&engine, &sid, "dbo", driver).await;

    run(&engine, &sid, "DROP TABLE tpm_it_items; DROP TABLE tpm_it_owners").await;
    engine.close_all().await;
}

/// SQL Server restore points: identity values come back (IDENTITY_INSERT), and so does a dropped table.
async fn restore_points_on_sql_server(engine: &Arc<Engine>, sid: &str) {
    let opts = RunOptions { confirmed: true, ..Default::default() };
    let point = |r: &tpm_core::engine::ScriptResult| {
        let note = r.statements.last().and_then(|s| s.restore.clone()).expect("note");
        note.point_id.clone().unwrap_or_else(|| panic!("no restore point: {note:?}"))
    };
    let all = |sql: &'static str| async move {
        run(engine, sid, sql).await.statements[0]
            .rows
            .clone()
            .unwrap()
            .iter()
            .map(|r| r.iter().map(|c| text(c).to_string()).collect::<Vec<_>>().join("|"))
            .collect::<Vec<_>>()
    };
    run(engine, sid, "DROP TABLE IF EXISTS tpm_it_msrp").await;
    run(
        engine,
        sid,
        "CREATE TABLE tpm_it_msrp (id int IDENTITY(10, 5) PRIMARY KEY, note nvarchar(20) NOT NULL, \
         amount money, at datetime2(3), total AS amount * 2)",
    )
    .await;
    run(
        engine,
        sid,
        "INSERT INTO tpm_it_msrp (note, amount, at) VALUES (N'a', 1.5, '2024-01-02 03:04:05.678'), \
         (N'b; é', NULL, NULL), (N'c', 3, '2024-05-06')",
    )
    .await;
    let before = all("SELECT id, note, amount, at, total FROM tpm_it_msrp ORDER BY id").await;

    let r = engine.run_script(sid, "DELETE FROM tpm_it_msrp WHERE id >= 15", opts.clone(), None).await.unwrap();
    engine.apply_restore(sid, &point(&r), None, true).await.unwrap();
    assert_eq!(
        all("SELECT id, note, amount, at, total FROM tpm_it_msrp ORDER BY id").await,
        before,
        "same ids and values"
    );

    let r = engine.run_script(sid, "UPDATE tpm_it_msrp SET note = N'x', amount = 0 WHERE id = 10", opts.clone(), None);
    engine.apply_restore(sid, &point(&r.await.unwrap()), None, true).await.unwrap();
    assert_eq!(all("SELECT id, note, amount, at, total FROM tpm_it_msrp ORDER BY id").await, before);

    let r = engine.run_script(sid, "DROP TABLE tpm_it_msrp", opts.clone(), None).await.unwrap();
    engine.apply_restore(sid, &point(&r), None, true).await.unwrap_or_else(|e| panic!("{e:?}"));
    assert_eq!(all("SELECT id, note, amount, at, total FROM tpm_it_msrp ORDER BY id").await, before);
    run(engine, sid, "INSERT INTO tpm_it_msrp (note) VALUES (N'd')").await;
    assert_eq!(
        all("SELECT max(id) FROM tpm_it_msrp").await,
        ["25"],
        "the identity keeps its step past the restored rows"
    );
    run(engine, sid, "DROP TABLE tpm_it_msrp").await;
}
