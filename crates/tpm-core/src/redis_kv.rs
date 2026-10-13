//! Redis support: a key-value browser and command console, not a relational adapter.
//!
//! Redis has no read-only session mode on a primary, so read-only connections are enforced
//! here: every command is classified by name (commands are structured argument vectors,
//! not free text, so this is an allowlist rather than a heuristic) and only read commands
//! run. Blocking and subscription commands are refused because they would hold the shared
//! connection.

use std::time::Duration;

use redis::aio::MultiplexedConnection;
use redis::{ConnectionAddr, IntoConnectionInfo, RedisConnectionInfo, Value};
use serde::Serialize;

use crate::config::{ConnectionProfile, SafetyMode, TlsMode};
use crate::error::{AppError, ErrorKind, Result};

/// Collection reads stop after this many elements; the total is reported separately.
pub const MAX_ITEMS: usize = 500;
/// String values larger than this are previewed.
pub const MAX_STRING_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandClass {
    Read,
    Write,
    Dangerous,
    Blocked,
}

/// Commands that never modify data.
const READ: &[&str] = &[
    "GET",
    "MGET",
    "GETRANGE",
    "STRLEN",
    "EXISTS",
    "TYPE",
    "TTL",
    "PTTL",
    "EXPIRETIME",
    "PEXPIRETIME",
    "SCAN",
    "HGET",
    "HMGET",
    "HGETALL",
    "HKEYS",
    "HVALS",
    "HLEN",
    "HEXISTS",
    "HSTRLEN",
    "HSCAN",
    "HRANDFIELD",
    "LRANGE",
    "LLEN",
    "LINDEX",
    "LPOS",
    "SMEMBERS",
    "SISMEMBER",
    "SMISMEMBER",
    "SCARD",
    "SSCAN",
    "SRANDMEMBER",
    "SINTER",
    "SUNION",
    "SDIFF",
    "SINTERCARD",
    "ZRANGE",
    "ZRANGEBYSCORE",
    "ZRANGEBYLEX",
    "ZREVRANGE",
    "ZREVRANGEBYSCORE",
    "ZREVRANGEBYLEX",
    "ZCARD",
    "ZCOUNT",
    "ZLEXCOUNT",
    "ZSCORE",
    "ZMSCORE",
    "ZRANK",
    "ZREVRANK",
    "ZSCAN",
    "ZRANDMEMBER",
    "ZINTER",
    "ZUNION",
    "ZDIFF",
    "ZINTERCARD",
    "XRANGE",
    "XREVRANGE",
    "XLEN",
    "XINFO",
    "XPENDING",
    "GETBIT",
    "BITCOUNT",
    "BITPOS",
    "PFCOUNT",
    "GEOPOS",
    "GEODIST",
    "GEOHASH",
    "GEOSEARCH",
    "DBSIZE",
    "INFO",
    "PING",
    "ECHO",
    "TIME",
    "LASTSAVE",
    "ROLE",
    "OBJECT",
    "MEMORY",
    "RANDOMKEY",
    "DUMP",
    "TOUCH",
    "COMMAND",
    "LOLWUT",
    "SORT_RO",
    "EVAL_RO",
    "EVALSHA_RO",
    "FCALL_RO",
    "JSON.GET",
    "JSON.MGET",
    "JSON.TYPE",
    "JSON.STRLEN",
    "JSON.ARRLEN",
    "JSON.OBJKEYS",
    "JSON.OBJLEN",
];

/// Commands that can destroy data, change server configuration or affect other clients.
const DANGEROUS: &[&str] = &[
    "FLUSHALL",
    "FLUSHDB",
    "CONFIG",
    "SHUTDOWN",
    "DEBUG",
    "SCRIPT",
    "FUNCTION",
    "CLIENT",
    "REPLICAOF",
    "SLAVEOF",
    "MIGRATE",
    "SWAPDB",
    "MODULE",
    "ACL",
    "FAILOVER",
    "CLUSTER",
    "KEYS",
    "SAVE",
    "BGSAVE",
    "BGREWRITEAOF",
    "RESTORE",
    "MOVE",
    "COPY",
    "RENAME",
    "UNLINK",
    "DEL",
    "SORT",
];

/// Commands that block or switch the connection into a mode the console cannot use.
const BLOCKED: &[&str] = &[
    "SUBSCRIBE",
    "PSUBSCRIBE",
    "SSUBSCRIBE",
    "UNSUBSCRIBE",
    "PUNSUBSCRIBE",
    "MONITOR",
    "SYNC",
    "PSYNC",
    "BLPOP",
    "BRPOP",
    "BLMOVE",
    "BRPOPLPUSH",
    "BLMPOP",
    "BZPOPMIN",
    "BZPOPMAX",
    "BZMPOP",
    "XREAD",
    "XREADGROUP",
    "WAIT",
    "WAITAOF",
    "QUIT",
    "RESET",
    "SELECT",
    "MULTI",
    "EXEC",
    "DISCARD",
    "WATCH",
    "HELLO",
    "AUTH",
];

pub fn classify(argv: &[String]) -> CommandClass {
    let name = argv.first().map(|s| s.to_ascii_uppercase()).unwrap_or_default();
    // Some multi-word commands are read-only by subcommand.
    let sub = argv.get(1).map(|s| s.to_ascii_uppercase()).unwrap_or_default();
    if BLOCKED.contains(&name.as_str()) {
        return CommandClass::Blocked;
    }
    if (name == "XREAD" || name == "XREADGROUP") && argv.iter().any(|a| a.eq_ignore_ascii_case("BLOCK")) {
        return CommandClass::Blocked;
    }
    if matches!(name.as_str(), "CONFIG" | "CLIENT" | "SCRIPT" | "FUNCTION" | "ACL" | "CLUSTER")
        && matches!(
            sub.as_str(),
            "GET"
                | "LIST"
                | "INFO"
                | "GETNAME"
                | "ID"
                | "EXISTS"
                | "WHOAMI"
                | "USERS"
                | "CAT"
                | "NODES"
                | "SLOTS"
                | "SHARDS"
        )
    {
        return CommandClass::Read;
    }
    if READ.contains(&name.as_str()) {
        return CommandClass::Read;
    }
    if DANGEROUS.contains(&name.as_str()) {
        return CommandClass::Dangerous;
    }
    CommandClass::Write
}

/// Splits a console line into arguments, honouring single and double quotes and
/// backslash escapes inside double quotes (like redis-cli).
pub fn parse_command_line(line: &str) -> Result<Vec<String>> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_arg = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' | '\'' => {
                in_arg = true;
                let q = c;
                let mut closed = false;
                while let Some(d) = chars.next() {
                    if d == q {
                        closed = true;
                        break;
                    }
                    if d == '\\' && q == '"' {
                        match chars.next() {
                            Some('n') => cur.push('\n'),
                            Some('t') => cur.push('\t'),
                            Some(e) => cur.push(e),
                            None => break,
                        }
                    } else {
                        cur.push(d);
                    }
                }
                if !closed {
                    return Err(AppError::invalid_config("Unterminated quote"));
                }
            }
            c if c.is_whitespace() => {
                if in_arg {
                    out.push(std::mem::take(&mut cur));
                    in_arg = false;
                }
            }
            c => {
                in_arg = true;
                cur.push(c);
            }
        }
    }
    if in_arg {
        out.push(cur);
    }
    Ok(out)
}

/// Whether the safety mode lets a command run, needs confirmation, or refuses it.
pub fn policy(mode: SafetyMode, class: CommandClass) -> crate::safety::PolicyDecision {
    use crate::safety::PolicyDecision::*;
    match (class, mode) {
        (CommandClass::Blocked, _) => {
            Block { reason: "This command blocks the connection and cannot be run from the console".into() }
        }
        (CommandClass::Read, _) => Allow,
        (_, SafetyMode::ReadOnly) => Block { reason: "This connection is read-only".into() },
        (CommandClass::Dangerous, SafetyMode::ConfirmDestructive | SafetyMode::ConfirmWrites) => {
            Confirm { reasons: vec!["This command can delete data or change the server".into()] }
        }
        (CommandClass::Write, SafetyMode::ConfirmWrites) => {
            Confirm { reasons: vec!["This command modifies data".into()] }
        }
        _ => Allow,
    }
}

pub struct RedisSession {
    conn: MultiplexedConnection,
    pub safety: SafetyMode,
    _tunnel: Option<crate::ssh::Tunnel>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisKey {
    pub key: String,
    pub kind: String,
    pub ttl: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanPage {
    pub cursor: String,
    pub keys: Vec<RedisKey>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RedisValue {
    None,
    #[serde(rename_all = "camelCase")]
    String {
        value: String,
        length: usize,
        truncated: bool,
        binary: bool,
    },
    #[serde(rename_all = "camelCase")]
    Hash {
        fields: Vec<(String, String)>,
        length: usize,
    },
    #[serde(rename_all = "camelCase")]
    List {
        items: Vec<String>,
        length: usize,
    },
    #[serde(rename_all = "camelCase")]
    Set {
        members: Vec<String>,
        length: usize,
    },
    #[serde(rename_all = "camelCase")]
    Zset {
        items: Vec<(String, f64)>,
        length: usize,
    },
    #[serde(rename_all = "camelCase")]
    Stream {
        entries: Vec<(String, Vec<(String, String)>)>,
        length: usize,
    },
    #[serde(rename_all = "camelCase")]
    Other {
        redis_type: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisInfo {
    pub version: String,
    pub mode: String,
    pub db: i64,
    pub keys: i64,
}

fn map_err(e: redis::RedisError) -> AppError {
    let msg = e.to_string();
    let kind = if e.is_io_error() || e.is_connection_dropped() || e.is_connection_refusal() {
        ErrorKind::Network
    } else if msg.contains("WRONGPASS") || msg.contains("NOAUTH") || msg.contains("invalid password") {
        ErrorKind::Authentication
    } else if msg.to_ascii_lowercase().contains("tls") || msg.contains("certificate") {
        ErrorKind::Tls
    } else {
        ErrorKind::Database
    };
    AppError::new(kind, msg)
}

async fn timed<T>(secs: u64, f: impl std::future::Future<Output = redis::RedisResult<T>>) -> Result<T> {
    match tokio::time::timeout(Duration::from_secs(secs), f).await {
        Ok(r) => r.map_err(map_err),
        Err(_) => Err(AppError::timeout(secs)),
    }
}

fn text(v: &[u8]) -> (String, bool) {
    match std::str::from_utf8(v) {
        Ok(s) => (s.to_string(), false),
        Err(_) => (format!("\\x{}", hex::encode(v)), true),
    }
}

fn as_text(v: &Value) -> String {
    match v {
        Value::BulkString(b) => text(b).0,
        Value::SimpleString(s) => s.clone(),
        Value::Int(n) => n.to_string(),
        Value::Double(d) => d.to_string(),
        Value::Boolean(b) => b.to_string(),
        Value::Okay => "OK".into(),
        Value::Nil => "(nil)".into(),
        Value::VerbatimString { text, .. } => text.clone(),
        other => format!("{other:?}"),
    }
}

/// redis-cli style rendering of a reply, for the console.
pub fn render(v: &Value, indent: usize) -> String {
    let pad = " ".repeat(indent);
    match v {
        Value::Nil => "(nil)".into(),
        Value::Int(n) => format!("(integer) {n}"),
        Value::Double(d) => format!("(double) {d}"),
        Value::Boolean(b) => format!("(boolean) {b}"),
        Value::Okay => "OK".into(),
        Value::SimpleString(s) => s.clone(),
        Value::BulkString(b) => format!("\"{}\"", text(b).0.replace('"', "\\\"")),
        Value::VerbatimString { text, .. } => text.clone(),
        Value::Array(items) | Value::Set(items) => {
            if items.is_empty() {
                return "(empty array)".into();
            }
            items
                .iter()
                .enumerate()
                .map(|(i, x)| {
                    format!("{}{}) {}", if i == 0 { String::new() } else { pad.clone() }, i + 1, render(x, indent + 3))
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
        Value::Map(pairs) => pairs
            .iter()
            .enumerate()
            .map(|(i, (k, val))| {
                format!(
                    "{}{}# {} => {}",
                    if i == 0 { String::new() } else { pad.clone() },
                    i + 1,
                    render(k, indent),
                    render(val, indent + 3)
                )
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Value::ServerError(e) => format!("(error) {e:?}"),
        other => format!("{other:?}"),
    }
}

impl RedisSession {
    pub async fn connect(
        profile: &ConnectionProfile,
        password: Option<&str>,
        tunnel: Option<crate::ssh::Tunnel>,
    ) -> Result<Self> {
        let db: i64 = if profile.database.trim().is_empty() {
            0
        } else {
            profile
                .database
                .trim()
                .parse()
                .map_err(|_| AppError::invalid_config("The Redis database must be a number (0–15)"))?
        };
        let (host, port) = match &tunnel {
            Some(t) => ("127.0.0.1".to_string(), t.local_port),
            None => (profile.host.clone(), profile.port.unwrap_or(6379)),
        };
        let addr = match profile.tls.mode {
            TlsMode::Disable | TlsMode::Prefer => ConnectionAddr::Tcp(host, port),
            TlsMode::Require | TlsMode::RequireInsecure => {
                if tunnel.is_some() && profile.tls.mode == TlsMode::Require {
                    return Err(AppError::unsupported(
                        "Verified TLS through an SSH tunnel is not supported for Redis; use the tunnel without TLS",
                    ));
                }
                ConnectionAddr::TcpTls {
                    host,
                    port,
                    insecure: profile.tls.mode == TlsMode::RequireInsecure,
                    tls_params: None,
                }
            }
        };
        let mut settings = RedisConnectionInfo::default().set_db(db);
        if !profile.user.trim().is_empty() {
            settings = settings.set_username(profile.user.trim());
        }
        if let Some(pw) = password {
            settings = settings.set_password(pw);
        }
        let info = addr.into_connection_info().map_err(map_err)?.set_redis_settings(settings);
        let client = redis::Client::open(info).map_err(map_err)?;
        let conn = timed(profile.connect_timeout_secs, client.get_multiplexed_async_connection()).await?;
        let mut s = Self { conn, safety: profile.safety_mode, _tunnel: tunnel };
        // Fail fast on authentication problems.
        let _: String = timed(10, redis::cmd("PING").query_async(&mut s.conn)).await?;
        Ok(s)
    }

    pub async fn info(&mut self) -> Result<RedisInfo> {
        let raw: String = timed(10, redis::cmd("INFO").arg("server").query_async(&mut self.conn)).await?;
        let field = |name: &str| {
            raw.lines()
                .find_map(|l| l.strip_prefix(&format!("{name}:")))
                .map(|v| v.trim().to_string())
                .unwrap_or_default()
        };
        let keys: i64 = timed(10, redis::cmd("DBSIZE").query_async(&mut self.conn)).await?;
        let db: i64 = timed(10, redis::cmd("CLIENT").arg("INFO").query_async::<String>(&mut self.conn))
            .await
            .ok()
            .and_then(|s| s.split_whitespace().find_map(|p| p.strip_prefix("db=")).and_then(|d| d.parse().ok()))
            .unwrap_or(0);
        Ok(RedisInfo { version: field("redis_version"), mode: field("redis_mode"), db, keys })
    }

    pub async fn scan(&mut self, cursor: &str, pattern: &str, count: usize) -> Result<ScanPage> {
        let pattern = if pattern.trim().is_empty() { "*" } else { pattern.trim() };
        let (next, keys): (String, Vec<Vec<u8>>) = timed(
            15,
            redis::cmd("SCAN")
                .arg(cursor)
                .arg("MATCH")
                .arg(pattern)
                .arg("COUNT")
                .arg(count.clamp(10, 10_000))
                .query_async(&mut self.conn),
        )
        .await?;
        let mut pipe = redis::pipe();
        for k in &keys {
            pipe.cmd("TYPE").arg(k).cmd("PTTL").arg(k);
        }
        let meta: Vec<Value> =
            if keys.is_empty() { vec![] } else { timed(15, pipe.query_async(&mut self.conn)).await? };
        let out = keys
            .iter()
            .enumerate()
            .map(|(i, k)| RedisKey {
                key: text(k).0,
                kind: meta.get(i * 2).map(as_text).unwrap_or_default(),
                ttl: match meta.get(i * 2 + 1) {
                    Some(Value::Int(n)) => *n,
                    _ => -1,
                },
            })
            .collect();
        Ok(ScanPage { cursor: next, keys: out })
    }

    pub async fn read(&mut self, key: &str) -> Result<RedisValue> {
        let kind: String = timed(10, redis::cmd("TYPE").arg(key).query_async(&mut self.conn)).await?;
        let c = &mut self.conn;
        let n = MAX_ITEMS as isize;
        Ok(match kind.as_str() {
            "none" => RedisValue::None,
            "string" => {
                let length: usize = timed(10, redis::cmd("STRLEN").arg(key).query_async(c)).await?;
                let bytes: Vec<u8> =
                    timed(10, redis::cmd("GETRANGE").arg(key).arg(0).arg(MAX_STRING_BYTES as i64 - 1).query_async(c))
                        .await?;
                let (value, binary) = text(&bytes);
                RedisValue::String { value, length, truncated: length > MAX_STRING_BYTES, binary }
            }
            "hash" => {
                let length: usize = timed(10, redis::cmd("HLEN").arg(key).query_async(c)).await?;
                let (_, flat): (String, Vec<Vec<u8>>) =
                    timed(10, redis::cmd("HSCAN").arg(key).arg(0).arg("COUNT").arg(MAX_ITEMS).query_async(c)).await?;
                let fields = flat
                    .chunks(2)
                    .take(MAX_ITEMS)
                    .map(|p| (text(&p[0]).0, p.get(1).map(|v| text(v).0).unwrap_or_default()))
                    .collect();
                RedisValue::Hash { fields, length }
            }
            "list" => {
                let length: usize = timed(10, redis::cmd("LLEN").arg(key).query_async(c)).await?;
                let items: Vec<Vec<u8>> =
                    timed(10, redis::cmd("LRANGE").arg(key).arg(0).arg(n - 1).query_async(c)).await?;
                RedisValue::List { items: items.iter().map(|v| text(v).0).collect(), length }
            }
            "set" => {
                let length: usize = timed(10, redis::cmd("SCARD").arg(key).query_async(c)).await?;
                let (_, members): (String, Vec<Vec<u8>>) =
                    timed(10, redis::cmd("SSCAN").arg(key).arg(0).arg("COUNT").arg(MAX_ITEMS).query_async(c)).await?;
                RedisValue::Set { members: members.iter().take(MAX_ITEMS).map(|v| text(v).0).collect(), length }
            }
            "zset" => {
                let length: usize = timed(10, redis::cmd("ZCARD").arg(key).query_async(c)).await?;
                let flat: Vec<Vec<u8>> =
                    timed(10, redis::cmd("ZRANGE").arg(key).arg(0).arg(n - 1).arg("WITHSCORES").query_async(c)).await?;
                let items = flat
                    .chunks(2)
                    .map(|p| {
                        (
                            text(&p[0]).0,
                            p.get(1)
                                .and_then(|s| std::str::from_utf8(s).ok())
                                .and_then(|s| s.parse().ok())
                                .unwrap_or(0.0),
                        )
                    })
                    .collect();
                RedisValue::Zset { items, length }
            }
            "stream" => {
                let length: usize = timed(10, redis::cmd("XLEN").arg(key).query_async(c)).await?;
                let raw: Value =
                    timed(10, redis::cmd("XRANGE").arg(key).arg("-").arg("+").arg("COUNT").arg(100).query_async(c))
                        .await?;
                let mut entries = Vec::new();
                if let Value::Array(list) = raw {
                    for e in list {
                        if let Value::Array(parts) = e
                            && parts.len() == 2
                        {
                            let id = as_text(&parts[0]);
                            let fields = match &parts[1] {
                                Value::Array(kv) => kv
                                    .chunks(2)
                                    .map(|p| (as_text(&p[0]), p.get(1).map(as_text).unwrap_or_default()))
                                    .collect(),
                                _ => vec![],
                            };
                            entries.push((id, fields));
                        }
                    }
                }
                RedisValue::Stream { entries, length }
            }
            other => RedisValue::Other { redis_type: other.to_string() },
        })
    }

    fn require_write(&self) -> Result<()> {
        if self.safety == SafetyMode::ReadOnly {
            return Err(AppError::new(ErrorKind::PolicyViolation, "This connection is read-only"));
        }
        Ok(())
    }

    pub async fn set_string(&mut self, key: &str, value: &str, keep_ttl: bool) -> Result<()> {
        self.require_write()?;
        let mut cmd = redis::cmd("SET");
        cmd.arg(key).arg(value);
        if keep_ttl {
            cmd.arg("KEEPTTL");
        }
        timed(10, cmd.query_async::<()>(&mut self.conn)).await
    }

    pub async fn hash_set(&mut self, key: &str, field: &str, value: &str) -> Result<()> {
        self.require_write()?;
        timed(10, redis::cmd("HSET").arg(key).arg(field).arg(value).query_async::<()>(&mut self.conn)).await
    }

    pub async fn hash_delete(&mut self, key: &str, field: &str) -> Result<()> {
        self.require_write()?;
        timed(10, redis::cmd("HDEL").arg(key).arg(field).query_async::<()>(&mut self.conn)).await
    }

    pub async fn delete(&mut self, key: &str) -> Result<bool> {
        self.require_write()?;
        let n: i64 = timed(10, redis::cmd("DEL").arg(key).query_async(&mut self.conn)).await?;
        Ok(n > 0)
    }

    /// Sets a TTL in seconds, or removes it when `seconds` is `None`.
    pub async fn expire(&mut self, key: &str, seconds: Option<i64>) -> Result<()> {
        self.require_write()?;
        match seconds {
            Some(s) if s > 0 => timed(10, redis::cmd("EXPIRE").arg(key).arg(s).query_async::<()>(&mut self.conn)).await,
            _ => timed(10, redis::cmd("PERSIST").arg(key).query_async::<()>(&mut self.conn)).await,
        }
    }

    /// Runs a console command after the safety policy; `confirmed` acknowledges a prompt.
    pub async fn command(&mut self, argv: &[String], confirmed: bool, timeout_secs: u64) -> Result<String> {
        if argv.is_empty() {
            return Err(AppError::invalid_config("Type a command"));
        }
        match policy(self.safety, classify(argv)) {
            crate::safety::PolicyDecision::Allow => {}
            crate::safety::PolicyDecision::Block { reason } => {
                return Err(AppError::new(ErrorKind::PolicyViolation, reason));
            }
            crate::safety::PolicyDecision::Confirm { reasons } if !confirmed => {
                return Err(AppError::new(ErrorKind::ConfirmationRequired, format!("Confirm `{}`", argv.join(" ")))
                    .with_detail(reasons.join("\n")));
            }
            crate::safety::PolicyDecision::Confirm { .. } => {}
        }
        let mut cmd = redis::cmd(&argv[0]);
        for a in &argv[1..] {
            cmd.arg(a);
        }
        let v: Value = timed(timeout_secs.clamp(1, 600), cmd.query_async(&mut self.conn)).await?;
        Ok(render(&v, 0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(s: &str) -> Vec<String> {
        parse_command_line(s).unwrap()
    }

    #[test]
    fn parses_quoted_arguments() {
        assert_eq!(argv(r#"SET "my key" 'it''s'"#), ["SET", "my key", "its"]);
        assert_eq!(argv(r#"SET k "line\nnext \"q\"""#), ["SET", "k", "line\nnext \"q\""]);
        assert_eq!(argv("  GET   k  "), ["GET", "k"]);
        assert_eq!(argv(r#"SET k """#), ["SET", "k", ""]);
        assert!(parse_command_line(r#"GET "open"#).is_err());
    }

    #[test]
    fn classifies_commands() {
        assert_eq!(classify(&argv("get k")), CommandClass::Read);
        assert_eq!(classify(&argv("HGETALL h")), CommandClass::Read);
        assert_eq!(classify(&argv("set k v")), CommandClass::Write);
        assert_eq!(classify(&argv("FLUSHALL")), CommandClass::Dangerous);
        assert_eq!(classify(&argv("config set maxmemory 1")), CommandClass::Dangerous);
        assert_eq!(classify(&argv("config get maxmemory")), CommandClass::Read);
        assert_eq!(classify(&argv("BLPOP q 0")), CommandClass::Blocked);
        assert_eq!(classify(&argv("subscribe chan")), CommandClass::Blocked);
        assert_eq!(classify(&argv("select 2")), CommandClass::Blocked);
    }

    #[test]
    fn policy_per_mode() {
        use crate::safety::PolicyDecision;
        assert_eq!(policy(SafetyMode::ReadOnly, CommandClass::Read), PolicyDecision::Allow);
        assert!(matches!(policy(SafetyMode::ReadOnly, CommandClass::Write), PolicyDecision::Block { .. }));
        assert!(matches!(
            policy(SafetyMode::ConfirmDestructive, CommandClass::Dangerous),
            PolicyDecision::Confirm { .. }
        ));
        assert_eq!(policy(SafetyMode::ConfirmDestructive, CommandClass::Write), PolicyDecision::Allow);
        assert!(matches!(policy(SafetyMode::ConfirmWrites, CommandClass::Write), PolicyDecision::Confirm { .. }));
        assert!(matches!(policy(SafetyMode::Normal, CommandClass::Blocked), PolicyDecision::Block { .. }));
    }

    #[test]
    fn renders_replies_like_redis_cli() {
        let v = Value::Array(vec![Value::BulkString(b"a".to_vec()), Value::Int(3), Value::Nil]);
        assert_eq!(render(&v, 0), "1) \"a\"\n2) (integer) 3\n3) (nil)");
        assert_eq!(render(&Value::Okay, 0), "OK");
    }
}
