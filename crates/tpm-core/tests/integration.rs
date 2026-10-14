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
        let plan = engine.explain(&sid, "SELECT * FROM tpm_it_items WHERE price > 1", false, false).await.unwrap();
        assert!(!plan.raw.is_empty());
        if driver == Driver::Postgres {
            let v: serde_json::Value = serde_json::from_str(&plan.raw).unwrap();
            assert!(v[0]["Plan"]["Node Type"].is_string());
        }
    } else {
        assert_eq!(engine.explain(&sid, "SELECT 1", false, false).await.unwrap_err().kind, ErrorKind::Unsupported);
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

    // --- cleanup ---
    run(&engine, &sid, "DROP TABLE tpm_it_items; DROP TABLE tpm_it_owners").await;
    engine.close_all().await;
}

/// Each engine reports where result columns come from (DuckDB cannot).
async fn origins(engine: &Engine, sid: &str, driver: Driver) {
    let r = run(engine, sid, "SELECT i.id, i.name AS label, o.name, i.price * 2 AS doubled, count(*) OVER () AS n FROM tpm_it_items i JOIN tpm_it_owners o ON o.id = i.owner_id").await;
    let cols = r.statements[0].columns.clone().expect("columns");
    let tables: Vec<Option<(String, String)>> = cols.iter().map(|c| c.origin.as_ref().map(|o| (o.table.clone(), o.column.clone()))).collect();
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
    let info = engine.open_session(&profile, pw, Some(ssh_pass), ConnectOptions::default()).await.expect("tunnel");
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
