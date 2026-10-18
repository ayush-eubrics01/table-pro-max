use std::sync::Arc;
use tpm_core::adapters::ConnectOptions;
use tpm_core::config::{SafetyMode, parse_connection_url};
use tpm_core::engine::{Engine, RunOptions};
use tpm_core::model::Cell;

async fn eng(mode: SafetyMode) -> (Arc<Engine>, String) {
    let url = std::env::var("TPM_TEST_MSSQL_URL").unwrap();
    let p = parse_connection_url(&url).unwrap();
    let mut profile = p.profile.clone();
    profile.safety_mode = mode;
    let engine = Arc::new(Engine::new());
    let info = engine.open_session(&profile, p.password.as_deref(), None, ConnectOptions::default()).await.unwrap();
    (engine, info.session_id)
}

async fn go(e: &Engine, sid: &str, sql: &str, max_rows: Option<usize>, timeout: Option<u64>) -> String {
    let r = e
        .run_script(
            sid,
            sql,
            RunOptions { confirmed: true, max_rows, timeout_secs: timeout, ..Default::default() },
            None,
        )
        .await;
    match r {
        Err(err) => format!("ERR {:?}: {}", err.kind, err.message),
        Ok(r) => {
            r.statements
                .iter()
                .map(|s| {
                    if let Some(e) = &s.error {
                        return format!("[err {:?} {} ctx={:?} pos={:?}]", e.kind, e.message, e.detail, e.position);
                    }
                    if let Some(rows) = &s.rows {
                        let v: Vec<String> = rows
                            .iter()
                            .take(5)
                            .map(|r| {
                                r.iter()
                                    .map(|c| match c {
                                        Cell::Text(t) => t.clone(),
                                        Cell::Null => "NULL".into(),
                                        other => format!("{other:?}"),
                                    })
                                    .collect::<Vec<_>>()
                                    .join("|")
                            })
                            .collect();
                        return format!("[rows n={} trunc={} {:?}]", rows.len(), s.truncated, v);
                    }
                    format!("[affected {:?}]", s.rows_affected)
                })
                .collect::<Vec<_>>()
                .join(" ")
                + if r.cancelled { " CANCELLED" } else { "" }
        }
    }
}

const BIG: &str = "SELECT TOP 100000 ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS v FROM sys.all_objects a CROSS JOIN sys.all_objects b";

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn probe() {
    let (e, sid) = eng(SafetyMode::Normal).await;
    let p = |s: &str| println!("{s}");
    p(&go(&e, &sid, "IF OBJECT_ID('zz_p') IS NOT NULL DROP TABLE zz_p; CREATE TABLE zz_p (id int PRIMARY KEY, v int); INSERT INTO zz_p VALUES (1,0),(2,0),(3,0)", None, None).await);

    p("== 1: open txn, then a failing plain SELECT");
    p(&go(&e, &sid, "BEGIN TRAN; UPDATE zz_p SET v = 1 WHERE id = 1", None, None).await);
    p(&go(&e, &sid, "SELECT @@TRANCOUNT", None, None).await);
    p(&go(&e, &sid, "SELECT * FROM no_such_table", None, None).await);
    p(&go(&e, &sid, "SELECT @@TRANCOUNT AS tc, (SELECT v FROM zz_p WHERE id=1) AS v", None, None).await);
    p(&go(&e, &sid, "IF @@TRANCOUNT>0 ROLLBACK; UPDATE zz_p SET v=0", None, None).await);

    p("== 2: cap cut in a mixed batch");
    p(&go(&e, &sid, "SELECT @@SPID", None, None).await);
    p(&go(
        &e,
        &sid,
        &format!("UPDATE zz_p SET v = 5 WHERE id = 1;\n{BIG};\nUPDATE zz_p SET v = 5 WHERE id = 2;"),
        Some(10),
        None,
    )
    .await);
    p(&go(&e, &sid, "SELECT @@SPID, (SELECT STRING_AGG(CONCAT(id,'=',v), ',') FROM zz_p)", None, None).await);
    p(&go(&e, &sid, "UPDATE zz_p SET v=0", None, None).await);

    p("== 3: cap cut inside a user txn");
    p(&go(&e, &sid, "BEGIN TRAN; UPDATE zz_p SET v = 7 WHERE id = 3", None, None).await);
    p(&go(&e, &sid, &format!("{BIG};\nSELECT 1"), Some(10), None).await);
    p(&go(&e, &sid, "SELECT @@SPID, @@TRANCOUNT, (SELECT v FROM zz_p WHERE id=3)", None, None).await);
    p(&go(&e, &sid, "IF @@TRANCOUNT>0 ROLLBACK; UPDATE zz_p SET v=0", None, None).await);

    p("== 4: USE then cancel (timeout)");
    p(&go(&e, &sid, "USE tempdb", None, None).await);
    p(&go(&e, &sid, "SELECT DB_NAME(), @@SPID", None, None).await);
    p(&go(&e, &sid, "WAITFOR DELAY '00:00:10'", None, Some(1)).await);
    p(&go(&e, &sid, "SELECT DB_NAME(), @@SPID", None, None).await);

    p("== 5: cancel during capped plain SELECT: ROWCOUNT leak?");
    p(&go(
        &e,
        &sid,
        "SELECT count_big(*) FROM sys.all_objects a CROSS JOIN sys.all_objects b CROSS JOIN sys.all_objects c",
        Some(3),
        Some(1),
    )
    .await);
    p(&go(&e, &sid, "SELECT @@SPID", None, None).await);
    p(&go(&e, &sid, "WITH c AS (SELECT TOP 10 name FROM sys.all_objects) SELECT * FROM c", Some(100), None).await);

    p("== 6: values");
    p(&go(&e, &sid, "SELECT CAST('2024-01-01 00:30:00.1234567 +05:30' AS datetimeoffset(7)), CAST('2024-01-01 23:30:00 -08:00' AS datetimeoffset(0)), CAST('2024-03-01 00:00:00.5 -00:30' AS datetimeoffset(1)), CAST('13:14:15' AS time(0)), CAST('13:14:15.1234567' AS time(7)), CAST('2024-02-29 01:02:03.45' AS datetime2(2)), CAST('2024-02-29 01:02:29.998' AS smalldatetime), CAST('2024-02-29 01:02:31' AS smalldatetime)", None, None).await);
    p(&go(&e, &sid, "SELECT CAST(-12.3456 AS money), CAST(-0.0001 AS money), CAST(922337203685477.5807 AS money), CAST(-214748.3648 AS smallmoney), CAST('6F9619FF-8B86-D011-B42D-00C04FD430C8' AS uniqueidentifier), CAST(N'x' AS sql_variant), CAST(1.5 AS sql_variant), CAST(-0.05 AS decimal(10,2)), CAST(-1.5 AS decimal(10,2)), CAST(0.001 AS decimal(10,3))", None, None).await);
    p(&go(&e, &sid, "SELECT CAST('2024-01-01' AS sql_variant), CAST(5 AS sql_variant), geography::Point(1,2,4326), hierarchyid::Parse('/1/2/'), CAST('1999-12-31 23:59:59.997' AS datetime), CAST(0x0102 AS rowversion), CAST(N'<a/>' AS xml), CAST(1e300 AS float), CAST(1.1 AS real), CAST('0001-01-01' AS date), CAST('9999-12-31 23:59:59.9999999' AS datetime2)", None, None).await);
}

const CONN: &str =
    "SELECT CONVERT(varchar(36), connection_id), @@TRANCOUNT FROM sys.dm_exec_connections WHERE session_id = @@SPID";

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn probe2() {
    let (e, sid) = eng(SafetyMode::Normal).await;
    let p = |s: &str| println!("{s}");
    p(&go(&e, &sid, "IF OBJECT_ID('zz_p') IS NOT NULL DROP TABLE zz_p; CREATE TABLE zz_p (id int PRIMARY KEY, v int); INSERT INTO zz_p VALUES (1,0),(2,0),(3,0)", None, None).await);
    p("== cap cut: reconnect?");
    p(&go(&e, &sid, CONN, None, None).await);
    p(&go(&e, &sid, &format!("{BIG};\nSELECT 1"), Some(10), None).await);
    p(&go(&e, &sid, CONN, None, None).await);
    p("== slow plain select cancelled by timeout: ROWCOUNT leak?");
    p(&go(&e, &sid, "SELECT MAX(CHECKSUM(NEWID())) FROM sys.all_objects a CROSS JOIN sys.all_objects b CROSS JOIN sys.all_objects c", Some(3), Some(1)).await);
    p(&go(&e, &sid, CONN, None, None).await);
    p(&go(&e, &sid, "WITH c AS (SELECT TOP 10 name FROM sys.all_objects) SELECT * FROM c", Some(100), None).await);
    p(&go(&e, &sid, "UPDATE zz_p SET v = 9", None, None).await);
    p("== user cancel via cancel_task before/while");
    let e2 = e.clone();
    let sid2 = sid.clone();
    let h = tokio::spawn(async move {
        e2.run_script(
            &sid2,
            "WAITFOR DELAY '00:00:05'; SELECT 1",
            RunOptions { confirmed: true, task_id: Some("tk".into()), timeout_secs: Some(0), ..Default::default() },
            None,
        )
        .await
        .map(|r| {
            (
                r.cancelled,
                r.statements
                    .iter()
                    .map(|s| format!("{:?}", s.error.as_ref().map(|e| (&e.message, &e.detail))))
                    .collect::<Vec<_>>(),
            )
        })
    });
    tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
    p(&format!("cancel_task -> {:?}", e.cancel_task("tk").await));
    p(&format!("{:?}", h.await.unwrap().map_err(|e| e.message)));
    p(&go(&e, &sid, CONN, None, None).await);

    p("== error position with GO and RO");
    p(&go(&e, &sid, "SELECT 1\nGO\n\n-- c\nSELECT 2;\nSELECT x FROM nope", None, None).await);

    p("== analyze (ConfirmDestructive)");
    let (ec, sidc) = eng(SafetyMode::ConfirmDestructive).await;
    let (er, sidr) = eng(SafetyMode::ReadOnly).await;
    for sql in [
        "UPDATE zz_p SET v = 1 FROM zz_p",
        "UPDATE t SET v = 1 FROM zz_p t",
        "MERGE zz_p AS t USING (SELECT 1 AS id) s ON t.id = s.id WHEN NOT MATCHED BY SOURCE THEN DELETE;",
        "EXEC sp_executesql N'DELETE FROM zz_p'",
        "BEGIN TRY TRUNCATE TABLE zz_p END TRY BEGIN CATCH END CATCH",
        "DELETE zz_p",
        "DELETE TOP (1) FROM zz_p",
        "UPDATE TOP (100) zz_p SET v = 1",
        "IF 1=1 TRUNCATE TABLE zz_p",
        "RESTORE DATABASE tpm_test FROM DISK = N'/tmp/x.bak' WITH REPLACE",
        "SHUTDOWN WITH NOWAIT",
        "DBCC CHECKDB (tpm_test, REPAIR_ALLOW_DATA_LOSS)",
        "sp_rename 'zz_p', 'zz_q'",
        "SELECT * FROM zz_p\nTRUNCATE TABLE zz_p",
        "SELECT 1 x\nDROP TABLE zz_p",
        "WITH c AS (SELECT * FROM zz_p) DELETE FROM c",
        "SELECT NEXT VALUE FOR dbo.s",
        "SELECT 1; COMMIT; SELECT 2",
        "SET IMPLICIT_TRANSACTIONS ON",
        "USE master",
        "BEGIN /* x */ TRAN; DELETE FROM zz_p; COMMIT",
        "INSERT INTO zz_p EXEC('SELECT 9, 9')",
        "DECLARE @c CURSOR; SET @c = CURSOR FOR SELECT id FROM zz_p FOR UPDATE; OPEN @c",
        "SAVE TRANSACTION s1",
        "SELECT * FROM OPENQUERY(lnk, 'DELETE FROM x')",
        "SELECT 1\nGO 2",
        "ALTER TABLE zz_p ALTER COLUMN v tinyint",
        "TRUNCATE TABLE zz_p WITH (PARTITIONS (1))",
        "DROP TABLE IF EXISTS zz_p",
        "WAITFOR DELAY '00:00:01'; DELETE FROM zz_p",
        "SET ROWCOUNT 1",
        "SELECT * FROM zz_p WITH (TABLOCKX, HOLDLOCK)",
    ] {
        let a = ec.analyze(&sidc, sql).unwrap();
        let r = er.analyze(&sidr, sql).unwrap();
        p(&format!(
            "{sql:?}\n   CD: {:?} {:?}\n   RO: {:?}",
            a.statements.iter().map(|s| (s.class, s.parsed)).collect::<Vec<_>>(),
            a.decision,
            matches!(r.decision, tpm_core::safety::PolicyDecision::Allow)
        ));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn probe3() {
    let (e, sid) = eng(SafetyMode::Normal).await;
    let p = |s: &str| println!("{s}");
    p(&go(&e, &sid, "IF OBJECT_ID('zz_p') IS NOT NULL DROP TABLE zz_p; CREATE TABLE zz_p (id int PRIMARY KEY, v int, w int); INSERT INTO zz_p VALUES (1,0,0),(2,0,0),(3,0,0)", None, None).await);
    p("== user SET ROWCOUNT reset by a plain SELECT");
    p(&go(&e, &sid, "SET ROWCOUNT 1", None, None).await);
    p(&format!("structure cols with ROWCOUNT 1: {}", e.table_structure(&sid, "dbo", "zz_p", false).await.map(|s| s.columns.len()).unwrap_or(999)));
    p(&go(&e, &sid, "SELECT * FROM zz_p", None, None).await);
    p(&go(&e, &sid, "UPDATE zz_p SET v = 1 WHERE id > 0", None, None).await);
    p("== RO");
    let (er, sidr) = eng(SafetyMode::ReadOnly).await;
    p(&go(&er, &sidr, "SELECT 1;\nSELECT x FROM nope", None, None).await);
    p(&go(&er, &sidr, "SELECT 1; COMMIT; SELECT @@TRANCOUNT", None, None).await);
    p(&go(&er, &sidr, "SET IMPLICIT_TRANSACTIONS ON", None, None).await);
    p(&go(&er, &sidr, "SELECT @@TRANCOUNT; SELECT 1", None, None).await);
    p(&go(&er, &sidr, "SELECT @@TRANCOUNT", None, None).await);
    p("== params");
    let r = e.run_script(&sid, "SELECT v FROM zz_p WHERE id = :id;\nSELECT y FROM nope", RunOptions { confirmed: true, parameters: Some([("id".to_string(), Some("2".to_string()))].into_iter().collect()), ..Default::default() }, None).await;
    p(&format!("{:?}", r.map(|r| r.statements.iter().map(|s| (s.rows.clone(), s.error.as_ref().map(|e| e.message.clone()))).collect::<Vec<_>>())));
}
