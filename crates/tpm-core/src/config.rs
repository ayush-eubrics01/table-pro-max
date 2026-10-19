//! Connection profiles and connection-URL parsing.
//!
//! A profile never contains a password. Secrets live in the credential store
//! (see [`crate::credentials`]) and are joined with the profile only at connect time.

use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::dialect::Dialect;
use crate::error::{AppError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Driver {
    Postgres,
    Mysql,
    Mariadb,
    Sqlite,
    /// Embedded DuckDB file (generated SQL uses the PostgreSQL dialect).
    Duckdb,
    /// Key-value store; handled by `redis_kv`, not the relational adapters.
    Redis,
    /// Microsoft SQL Server and Azure SQL.
    Mssql,
    /// Document store; handled by `mongo`, not the relational adapters.
    Mongodb,
}

impl Driver {
    /// The database's own catalog tables: never edited from the app (results or grid commits).
    pub fn is_system_table(self, schema: &str, table: &str) -> bool {
        let schema = schema.to_ascii_lowercase();
        match self {
            Driver::Postgres => matches!(schema.as_str(), "pg_catalog" | "information_schema" | "pg_toast"),
            Driver::Mysql | Driver::Mariadb => {
                matches!(schema.as_str(), "mysql" | "information_schema" | "performance_schema" | "sys")
            }
            Driver::Sqlite => table.to_ascii_lowercase().starts_with("sqlite_"),
            Driver::Duckdb => matches!(schema.as_str(), "information_schema" | "pg_catalog"),
            Driver::Mssql => matches!(schema.as_str(), "sys" | "information_schema"),
            // MongoDB's own collections (users, roles, views, profiles) live in system.*.
            Driver::Mongodb => table.starts_with("system."),
            Driver::Redis => false,
        }
    }

    pub fn dialect(self) -> Dialect {
        match self {
            Driver::Postgres => Dialect::Postgres,
            Driver::Mysql | Driver::Mariadb => Dialect::Mysql,
            Driver::Sqlite => Dialect::Sqlite,
            Driver::Mssql => Dialect::Mssql,
            // Redis and MongoDB are not SQL; the dialect is never used for them.
            Driver::Duckdb | Driver::Redis | Driver::Mongodb => Dialect::Postgres,
        }
    }

    pub fn default_port(self) -> Option<u16> {
        match self {
            Driver::Postgres => Some(5432),
            Driver::Mysql | Driver::Mariadb => Some(3306),
            Driver::Sqlite | Driver::Duckdb => None,
            Driver::Redis => Some(6379),
            Driver::Mssql => Some(1433),
            Driver::Mongodb => Some(27017),
        }
    }

    pub fn is_file_based(self) -> bool {
        matches!(self, Driver::Sqlite | Driver::Duckdb)
    }

    fn scheme(self) -> &'static str {
        match self {
            Driver::Postgres => "postgres",
            Driver::Mysql => "mysql",
            Driver::Mariadb => "mariadb",
            Driver::Sqlite => "sqlite",
            Driver::Duckdb => "duckdb",
            Driver::Redis => "redis",
            Driver::Mssql => "sqlserver",
            Driver::Mongodb => "mongodb",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Environment {
    #[default]
    Local,
    Development,
    Testing,
    Staging,
    Production,
}

/// Query safety policy applied by the backend before executing user-authored SQL.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SafetyMode {
    Normal,
    #[default]
    ConfirmDestructive,
    ConfirmWrites,
    ReadOnly,
}

/// TLS behaviour. Certificate verification is on for every mode except `RequireInsecure`,
/// which must be chosen explicitly and is labelled as insecure in the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TlsMode {
    Disable,
    /// Use TLS when the server offers it (certificate verified), otherwise plaintext.
    #[default]
    Prefer,
    /// TLS is mandatory and the certificate chain and hostname are verified.
    Require,
    /// TLS is mandatory but the certificate is NOT verified. Protects against passive
    /// eavesdropping only.
    RequireInsecure,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TlsConfig {
    pub mode: TlsMode,
    /// Optional PEM file with additional trusted CA certificates.
    #[serde(default)]
    pub ca_cert_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PasswordMode {
    /// Stored in the operating system's credential store.
    #[default]
    Keychain,
    /// Prompted for at connect time and kept in memory for the session only.
    Ask,
    /// No password (e.g. SQLite, trust or socket authentication).
    None,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub driver: Driver,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub database: String,
    /// SQLite database file.
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub tls: TlsConfig,
    #[serde(default)]
    pub password_mode: PasswordMode,
    #[serde(default)]
    pub environment: Environment,
    #[serde(default)]
    pub safety_mode: SafetyMode,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default = "default_connect_timeout")]
    pub connect_timeout_secs: u64,
    /// 0 disables the per-query timeout.
    #[serde(default)]
    pub query_timeout_secs: u64,
    #[serde(default = "default_keepalive")]
    pub keepalive_secs: u64,
    /// Optional SSH tunnel to reach the database host.
    #[serde(default)]
    pub ssh: Option<crate::ssh::SshConfig>,
    /// Keep restore points (copies of rows before a change, on this computer). On by default.
    #[serde(default = "default_true")]
    pub restore_points: bool,
    /// MongoDB: find the hosts through DNS (`mongodb+srv://`, as Atlas needs).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub srv: bool,
    /// MongoDB: the database the user is defined in (`authSource`), when not the default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_source: Option<String>,
    /// MongoDB: talk to this one server only, without discovering the rest of its replica set
    /// (`directConnection=true`: Docker and port-forwarded servers).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub direct_connection: bool,
}

fn default_true() -> bool {
    true
}
fn default_connect_timeout() -> u64 {
    10
}
fn default_keepalive() -> u64 {
    60
}

impl ConnectionProfile {
    pub fn new(name: impl Into<String>, driver: Driver) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            driver,
            host: if driver.is_file_based() { String::new() } else { "localhost".into() },
            port: driver.default_port(),
            user: String::new(),
            database: String::new(),
            file_path: None,
            tls: TlsConfig::default(),
            password_mode: if driver.is_file_based() { PasswordMode::None } else { PasswordMode::Keychain },
            environment: Environment::Local,
            safety_mode: SafetyMode::default(),
            color: None,
            group: None,
            tags: Vec::new(),
            connect_timeout_secs: default_connect_timeout(),
            query_timeout_secs: 0,
            keepalive_secs: default_keepalive(),
            ssh: None,
            restore_points: true,
            srv: false,
            auth_source: None,
            direct_connection: false,
        }
    }

    pub fn dialect(&self) -> Dialect {
        self.driver.dialect()
    }

    pub fn port_or_default(&self) -> u16 {
        self.port.or(self.driver.default_port()).unwrap_or(0)
    }

    pub fn read_only(&self) -> bool {
        self.safety_mode == SafetyMode::ReadOnly
    }

    pub fn validate(&self) -> Result<()> {
        if self.name.trim().is_empty() {
            return Err(AppError::invalid_config("Connection name is required"));
        }
        if self.driver.is_file_based() {
            if self.file_path.as_deref().is_none_or(|p| p.trim().is_empty()) {
                return Err(AppError::invalid_config("A database file path is required"));
            }
        } else {
            if self.host.trim().is_empty() {
                return Err(AppError::invalid_config("Host is required"));
            }
            if self.host.chars().any(|c| c.is_whitespace() || c == '/') {
                return Err(AppError::invalid_config("Host must not contain spaces or slashes"));
            }
            if self.port == Some(0) {
                return Err(AppError::invalid_config("Port must be between 1 and 65535"));
            }
        }
        if let Some(ssh) = &self.ssh {
            if self.driver.is_file_based() {
                return Err(AppError::invalid_config("SSH tunnels apply to network databases only"));
            }
            ssh.validate()?;
        }
        if self.connect_timeout_secs == 0 || self.connect_timeout_secs > 600 {
            return Err(AppError::invalid_config("Connect timeout must be between 1 and 600 seconds"));
        }
        Ok(())
    }

    /// A display string for the target, never containing secrets.
    pub fn target_label(&self) -> String {
        if self.driver.is_file_based() {
            self.file_path.clone().unwrap_or_default()
        } else {
            let db = if self.database.is_empty() { String::new() } else { format!("/{}", self.database) };
            format!("{}@{}:{}{}", self.user, self.host, self.port_or_default(), db)
        }
    }

    /// Connection URL without the password (used for export and display).
    pub fn to_url(&self) -> String {
        if self.driver == Driver::Mongodb {
            return self.mongo_url();
        }
        if self.driver.is_file_based() {
            return format!("{}://{}", self.driver.scheme(), self.file_path.clone().unwrap_or_default());
        }
        let mut url = Url::parse(&format!("{}://placeholder", self.driver.scheme())).expect("static url");
        let _ = url.set_host(Some(&self.host));
        let _ = url.set_port(self.port);
        let _ = url.set_username(&self.user);
        url.set_path(&self.database);
        let ssl = match self.tls.mode {
            TlsMode::Disable => "disable",
            TlsMode::Prefer => "prefer",
            TlsMode::Require => "verify-full",
            TlsMode::RequireInsecure => "require",
        };
        url.query_pairs_mut().append_pair("sslmode", ssl);
        url.to_string()
    }
}

impl ConnectionProfile {
    fn mongo_url(&self) -> String {
        let scheme = if self.srv { "mongodb+srv" } else { "mongodb" };
        let mut url = Url::parse(&format!("{scheme}://placeholder")).expect("static url");
        let _ = url.set_host(Some(&self.host));
        if !self.srv {
            let _ = url.set_port(self.port);
        }
        let _ = url.set_username(&self.user);
        url.set_path(&format!("/{}", self.database));
        {
            let mut q = url.query_pairs_mut();
            if let Some(source) = &self.auth_source {
                q.append_pair("authSource", source);
            }
            if self.direct_connection {
                q.append_pair("directConnection", "true");
            }
            match self.tls.mode {
                TlsMode::Disable => {}
                TlsMode::Prefer if !self.srv => {}
                _ => {
                    q.append_pair("tls", "true");
                }
            }
            if self.tls.mode == TlsMode::RequireInsecure {
                q.append_pair("tlsAllowInvalidCertificates", "true");
            }
            if let Some(ca) = &self.tls.ca_cert_path {
                q.append_pair("tlsCAFile", ca);
            }
        }
        url.to_string().replace("?&", "?").trim_end_matches('?').to_string()
    }
}

/// Result of parsing a connection URL. The password is returned separately so the
/// caller can hand it to the credential store rather than persisting it.
#[derive(Debug, Clone)]
pub struct ParsedUrl {
    pub profile: ConnectionProfile,
    pub password: Option<String>,
}

/// Parses `postgres://`, `postgresql://`, `mysql://`, `mariadb://`, `sqlserver://`, `redis://`,
/// `sqlite:` and `duckdb:` URLs, and SQL Server's ADO.NET connection strings.
pub fn parse_connection_url(input: &str) -> Result<ParsedUrl> {
    let input = input.trim();
    if input.is_empty() {
        return Err(AppError::invalid_config("Connection URL is empty"));
    }
    if is_ado_string(input) {
        return parse_ado_string(input);
    }
    if let Some(path) = file_path_for(input, "duckdb") {
        let mut profile = ConnectionProfile::new(file_name(&path), Driver::Duckdb);
        profile.file_path = Some(path);
        return Ok(ParsedUrl { profile, password: None });
    }
    if let Some(path) = sqlite_path(input) {
        let mut profile = ConnectionProfile::new(file_name(&path), Driver::Sqlite);
        profile.file_path = Some(path);
        return Ok(ParsedUrl { profile, password: None });
    }

    if let Some(rest) = input.strip_prefix("mongodb://").or_else(|| input.strip_prefix("mongodb+srv://")) {
        let authority = rest.split(['/', '?']).next().unwrap_or_default();
        let hosts = authority.rsplit('@').next().unwrap_or_default();
        if hosts.contains(',') {
            return Err(AppError::unsupported(
                "MongoDB connections take one host, or a mongodb+srv:// address; several hosts aren't supported yet",
            ));
        }
    }

    // Parse without echoing the input: it may contain a password.
    let url = Url::parse(input).map_err(|e| AppError::invalid_config(format!("Invalid connection URL: {e}")))?;
    let driver = match url.scheme() {
        "postgres" | "postgresql" => Driver::Postgres,
        "mysql" => Driver::Mysql,
        "mariadb" => Driver::Mariadb,
        "redis" | "rediss" => Driver::Redis,
        "sqlserver" | "mssql" => Driver::Mssql,
        "mongodb" | "mongodb+srv" => Driver::Mongodb,
        other => return Err(AppError::invalid_config(format!("Unsupported URL scheme '{other}'"))),
    };

    let tls_scheme = url.scheme() == "rediss";
    let host = url.host_str().unwrap_or("localhost");
    let host = host.trim_start_matches('[').trim_end_matches(']').to_string();
    let user = decode(url.username())?;
    let password = url.password().map(decode).transpose()?.filter(|p| !p.is_empty());
    let database = decode(url.path().trim_start_matches('/'))?;

    let mut profile =
        ConnectionProfile::new(if database.is_empty() { host.clone() } else { format!("{database} @ {host}") }, driver);
    profile.host = host;
    profile.port = url.port().or(driver.default_port());
    profile.user = user;
    profile.database = database;
    profile.password_mode = if password.is_some() { PasswordMode::Keychain } else { PasswordMode::Ask };
    if driver == Driver::Mongodb {
        profile.srv = url.scheme() == "mongodb+srv";
        if profile.srv {
            profile.port = None;
        }
        // Without a user there is nothing to sign in with.
        if password.is_none() && profile.user.is_empty() {
            profile.password_mode = PasswordMode::None;
        }
        // MongoDB's defaults: TLS with SRV (Atlas), none without, unless the URL says.
        profile.tls.mode = if profile.srv { TlsMode::Require } else { TlsMode::Disable };
        let truthy = |v: &str| v.eq_ignore_ascii_case("true");
        let mut insecure = false;
        for (k, v) in url.query_pairs() {
            match k.as_ref() {
                "authSource" => profile.auth_source = Some(v.into_owned()).filter(|s| !s.is_empty()),
                "directConnection" => profile.direct_connection = truthy(&v),
                "tls" | "ssl" => {
                    profile.tls.mode = if truthy(&v) { TlsMode::Require } else { TlsMode::Disable };
                }
                "tlsAllowInvalidCertificates" | "tlsInsecure" => insecure = truthy(&v),
                "tlsCAFile" => profile.tls.ca_cert_path = Some(v.into_owned()),
                _ => {}
            }
        }
        if insecure && profile.tls.mode != TlsMode::Disable {
            profile.tls.mode = TlsMode::RequireInsecure;
        }
        let password = password.or_else(|| {
            url.query_pairs().find(|(k, _)| k.eq_ignore_ascii_case("password")).map(|(_, v)| v.into_owned())
        });
        if password.is_some() {
            profile.password_mode = PasswordMode::Keychain;
        }
        return Ok(ParsedUrl { profile, password });
    }
    if driver == Driver::Redis {
        // Redis usually has no password; `rediss://` means TLS.
        if password.is_none() {
            profile.password_mode = PasswordMode::None;
        }
        profile.tls.mode = if tls_scheme { TlsMode::Require } else { TlsMode::Disable };
    }

    for (k, v) in url.query_pairs() {
        match k.to_ascii_lowercase().as_str() {
            "sslmode" | "ssl-mode" | "ssl_mode" => profile.tls.mode = parse_ssl_mode(&v)?,
            "sslrootcert" | "ssl-ca" | "ssl_ca" => profile.tls.ca_cert_path = Some(v.into_owned()),
            "connect_timeout" | "connect-timeout" => {
                if let Ok(n) = v.parse::<u64>() {
                    profile.connect_timeout_secs = n.clamp(1, 600);
                }
            }
            "user" if profile.user.is_empty() => profile.user = v.into_owned(),
            "dbname" | "database" if profile.database.is_empty() => profile.database = v.into_owned(),
            // Passwords in the query string are accepted but never stored in the profile.
            _ => {}
        }
    }
    let password = password
        .or_else(|| url.query_pairs().find(|(k, _)| k.eq_ignore_ascii_case("password")).map(|(_, v)| v.into_owned()));
    if password.is_some() {
        profile.password_mode = PasswordMode::Keychain;
    }
    Ok(ParsedUrl { profile, password })
}

/// `Server=…;Database=…` (no `://`), as the Azure portal and SQL Server tools give them.
fn is_ado_string(input: &str) -> bool {
    !input.contains("://") && {
        let first = input.split(['=', ';']).next().unwrap_or_default().trim().to_ascii_lowercase();
        matches!(first.as_str(), "server" | "data source" | "address" | "addr" | "network address")
    }
}

/// Splits `key=value;…` pairs. A value in `{…}` may hold `;` and `=`, with `}}` for a `}`; one
/// in double or single quotes may hold `;`.
fn ado_pairs(input: &str) -> Result<Vec<(String, String)>> {
    let mut pairs = Vec::new();
    let mut rest = input;
    while !rest.trim().is_empty() {
        let eq =
            rest.find('=').ok_or_else(|| AppError::invalid_config("Invalid connection string: expected key=value"))?;
        let key = rest[..eq].trim().to_ascii_lowercase();
        let after = rest[eq + 1..].trim_start();
        let (value, tail) = match after.chars().next() {
            Some('{') => {
                let mut value = String::new();
                let mut chars = after[1..].char_indices();
                let mut end = None;
                while let Some((i, c)) = chars.next() {
                    if c == '}' {
                        if after[1 + i + 1..].starts_with('}') {
                            value.push('}');
                            chars.next();
                        } else {
                            end = Some(1 + i + 1);
                            break;
                        }
                    } else {
                        value.push(c);
                    }
                }
                let end = end.ok_or_else(|| AppError::invalid_config("Invalid connection string: unclosed {"))?;
                (value, &after[end..])
            }
            Some(q @ ('"' | '\'')) => {
                let close = after[1..]
                    .find(q)
                    .ok_or_else(|| AppError::invalid_config("Invalid connection string: unclosed quote"))?;
                (after[1..1 + close].to_string(), &after[close + 2..])
            }
            _ => {
                let end = after.find(';').unwrap_or(after.len());
                (after[..end].trim().to_string(), &after[end..])
            }
        };
        if !key.is_empty() {
            pairs.push((key, value));
        }
        rest = tail.trim_start().strip_prefix(';').unwrap_or(tail.trim_start());
    }
    Ok(pairs)
}

fn parse_ado_string(input: &str) -> Result<ParsedUrl> {
    let truthy = |v: &str| matches!(v.to_ascii_lowercase().as_str(), "true" | "yes" | "mandatory" | "strict" | "sspi");
    let pairs = ado_pairs(input)?;
    let get = |keys: &[&str]| pairs.iter().rev().find(|(k, _)| keys.contains(&k.as_str())).map(|(_, v)| v.clone());
    if get(&["integrated security", "trusted_connection"]).is_some_and(|v| truthy(&v))
        || get(&["authentication"]).is_some_and(|v| !v.eq_ignore_ascii_case("sqlpassword"))
    {
        return Err(AppError::unsupported(
            "Windows and Microsoft Entra sign-in aren't supported yet. Use a SQL Server login (user name and password).",
        ));
    }
    let server = get(&["server", "data source", "address", "addr", "network address"]).unwrap_or_default();
    let server = server.trim();
    let server = server.strip_prefix("tcp:").unwrap_or(server);
    let (host, port) = match server.rsplit_once(',') {
        Some((h, p)) => {
            let port = p.trim().parse::<u16>().map_err(|_| AppError::invalid_config("Invalid port in Server"))?;
            (h.trim(), Some(port))
        }
        None => (server, None),
    };
    if host.contains('\\') {
        return Err(AppError::unsupported(
            "Named instances (server\\instance) aren't supported yet. Use the instance's TCP port: Server=host,port.",
        ));
    }
    let host = match host {
        "" | "." | "(local)" => "localhost",
        h => h,
    };
    let database = get(&["database", "initial catalog"]).unwrap_or_default();
    let mut profile = ConnectionProfile::new(
        if database.is_empty() { host.to_string() } else { format!("{database} @ {host}") },
        Driver::Mssql,
    );
    profile.host = host.to_string();
    profile.port = port.or(Driver::Mssql.default_port());
    profile.database = database;
    profile.user = get(&["user id", "uid", "user", "username"]).unwrap_or_default();
    let encrypt = get(&["encrypt"]).is_none_or(|v| truthy(&v));
    let trust = get(&["trustservercertificate", "trust server certificate"]).is_some_and(|v| truthy(&v));
    profile.tls.mode = match (encrypt, trust) {
        (false, _) => TlsMode::Disable,
        (true, true) => TlsMode::RequireInsecure,
        (true, false) => TlsMode::Require,
    };
    if let Some(n) = get(&["connect timeout", "connection timeout", "timeout"]).and_then(|v| v.parse::<u64>().ok()) {
        profile.connect_timeout_secs = n.clamp(1, 600);
    }
    let password = get(&["password", "pwd"]).filter(|p| !p.is_empty());
    profile.password_mode = if password.is_some() { PasswordMode::Keychain } else { PasswordMode::Ask };
    Ok(ParsedUrl { profile, password })
}

fn parse_ssl_mode(v: &str) -> Result<TlsMode> {
    Ok(match v.to_ascii_lowercase().replace('_', "-").as_str() {
        "disable" | "disabled" | "false" | "0" => TlsMode::Disable,
        "allow" | "prefer" | "preferred" => TlsMode::Prefer,
        // libpq's `require` does not verify certificates; keep those semantics explicit.
        "require" | "required" | "true" | "1" => TlsMode::RequireInsecure,
        "verify-ca" | "verify-full" | "verify-identity" => TlsMode::Require,
        other => return Err(AppError::invalid_config(format!("Unknown sslmode '{other}'"))),
    })
}

fn decode(s: &str) -> Result<String> {
    percent_decode_str(s)
        .decode_utf8()
        .map(|c| c.into_owned())
        .map_err(|_| AppError::invalid_config("Connection URL contains invalid UTF-8 escapes"))
}

fn file_path_for(input: &str, scheme: &str) -> Option<String> {
    let rest = input.strip_prefix(&format!("{scheme}://")).or_else(|| input.strip_prefix(&format!("{scheme}:")))?;
    let rest = rest.split('?').next().unwrap_or(rest);
    let path = percent_decode_str(rest).decode_utf8_lossy().into_owned();
    (!path.is_empty()).then_some(path)
}

fn sqlite_path(input: &str) -> Option<String> {
    let rest = input
        .strip_prefix("sqlite://")
        .or_else(|| input.strip_prefix("sqlite:"))
        .or_else(|| input.strip_prefix("file://"))?;
    let rest = rest.split('?').next().unwrap_or(rest);
    let path = percent_decode_str(rest).decode_utf8_lossy().into_owned();
    (!path.is_empty()).then_some(path)
}

fn file_name(path: &str) -> String {
    std::path::Path::new(path).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_tables_are_recognised_per_engine() {
        assert!(Driver::Postgres.is_system_table("pg_catalog", "pg_class"));
        assert!(Driver::Postgres.is_system_table("information_schema", "tables"));
        assert!(Driver::Postgres.is_system_table("pg_toast", "pg_toast_1234"));
        assert!(!Driver::Postgres.is_system_table("public", "pg_notes"), "a user table may start with pg_");
        assert!(!Driver::Postgres.is_system_table("sys", "users"), "sys is an ordinary schema on PostgreSQL");
        assert!(Driver::Mysql.is_system_table("mysql", "user"));
        assert!(Driver::Mariadb.is_system_table("performance_schema", "threads"));
        assert!(Driver::Mysql.is_system_table("sys", "host_summary"));
        assert!(Driver::Mysql.is_system_table("INFORMATION_SCHEMA", "TABLES"), "MySQL names are case-insensitive");
        assert!(!Driver::Mysql.is_system_table("shop", "mysql_users"));
        assert!(Driver::Sqlite.is_system_table("main", "sqlite_sequence"));
        assert!(Driver::Sqlite.is_system_table("main", "SQLITE_MASTER"));
        assert!(!Driver::Sqlite.is_system_table("main", "orders"));
        assert!(Driver::Duckdb.is_system_table("information_schema", "columns"));
        assert!(!Driver::Duckdb.is_system_table("main", "orders"));
        assert!(Driver::Mssql.is_system_table("sys", "objects"));
        assert!(Driver::Mssql.is_system_table("INFORMATION_SCHEMA", "TABLES"));
        assert!(!Driver::Mssql.is_system_table("dbo", "orders"));
    }

    #[test]
    fn parses_sql_server_urls() {
        let p = parse_connection_url("sqlserver://app:p%40w@db.example.com/shop?sslmode=verify-full").unwrap();
        assert_eq!(p.profile.driver, Driver::Mssql);
        assert_eq!(p.profile.port, Some(1433));
        assert_eq!(p.profile.database, "shop");
        assert_eq!(p.profile.user, "app");
        assert_eq!(p.password.as_deref(), Some("p@w"));
        assert_eq!(p.profile.tls.mode, TlsMode::Require);
        assert_eq!(p.profile.to_url(), "sqlserver://app@db.example.com:1433/shop?sslmode=verify-full");
        assert_eq!(parse_connection_url("mssql://h:1444/x").unwrap().profile.port, Some(1444));
        assert_eq!(Driver::Mssql.dialect(), Dialect::Mssql);
    }

    #[test]
    fn parses_mongodb_urls() {
        let p =
            parse_connection_url("mongodb://app:s%3Acret@db.example.com:27018/shop?authSource=admin&tls=true").unwrap();
        assert_eq!(p.profile.driver, Driver::Mongodb);
        assert_eq!((p.profile.host.as_str(), p.profile.port), ("db.example.com", Some(27018)));
        assert_eq!((p.profile.user.as_str(), p.profile.database.as_str()), ("app", "shop"));
        assert_eq!(p.password.as_deref(), Some("s:cret"));
        assert_eq!(p.profile.auth_source.as_deref(), Some("admin"));
        assert!(!p.profile.srv);
        assert_eq!(p.profile.tls.mode, TlsMode::Require);
        assert!(!serde_json::to_string(&p.profile).unwrap().contains("s:cret"));
        let p = parse_connection_url("mongodb://h/db").unwrap();
        assert_eq!((p.profile.port, p.profile.tls.mode), (Some(27017), TlsMode::Disable));
        assert_eq!(p.profile.password_mode, PasswordMode::None);
        // Atlas: hosts from DNS, TLS on unless the URL says otherwise.
        let p = parse_connection_url("mongodb+srv://app:pw@cluster0.abcd.mongodb.net/?retryWrites=true").unwrap();
        assert!(p.profile.srv);
        assert_eq!(p.profile.port, None);
        assert_eq!(p.profile.tls.mode, TlsMode::Require);
        assert_eq!(p.profile.to_url(), "mongodb+srv://app@cluster0.abcd.mongodb.net/?tls=true");
        let p = parse_connection_url("mongodb://h:27019/db?directConnection=true").unwrap();
        assert!(p.profile.direct_connection);
        assert_eq!(p.profile.to_url(), "mongodb://h:27019/db?directConnection=true");
        let p = parse_connection_url("mongodb://h/db?tls=true&tlsAllowInvalidCertificates=true&tlsCAFile=%2Fca.pem")
            .unwrap();
        assert_eq!(p.profile.tls.mode, TlsMode::RequireInsecure);
        assert_eq!(p.profile.tls.ca_cert_path.as_deref(), Some("/ca.pem"));
        assert!(parse_connection_url("mongodb://a:1,b:2/db").unwrap_err().message.contains("one host"));
        assert!(Driver::Mongodb.is_system_table("admin", "system.users"));
        assert!(!Driver::Mongodb.is_system_table("shop", "orders"));
    }

    #[test]
    fn parses_ado_net_connection_strings() {
        let p = parse_connection_url(
            "Server=tcp:db.example.com,1444;Initial Catalog=shop;Persist Security Info=False;User ID=app;\
             Password={p;w}}x};MultipleActiveResultSets=False;Encrypt=True;TrustServerCertificate=False;\
             Connection Timeout=30;",
        )
        .unwrap();
        assert_eq!(p.profile.driver, Driver::Mssql);
        assert_eq!(p.profile.host, "db.example.com");
        assert_eq!(p.profile.port, Some(1444));
        assert_eq!(p.profile.database, "shop");
        assert_eq!(p.profile.user, "app");
        assert_eq!(p.password.as_deref(), Some("p;w}x"));
        assert_eq!(p.profile.tls.mode, TlsMode::Require);
        assert_eq!(p.profile.connect_timeout_secs, 30);
        assert_eq!(p.profile.password_mode, PasswordMode::Keychain);
        assert!(!format!("{:?}", p.profile).contains("p;w"));

        let p = parse_connection_url("Data Source=localhost;Database=x;UID=sa;Encrypt=yes;TrustServerCertificate=true")
            .unwrap();
        assert_eq!((p.profile.host.as_str(), p.profile.port), ("localhost", Some(1433)));
        assert_eq!(p.profile.tls.mode, TlsMode::RequireInsecure);
        assert_eq!(p.profile.password_mode, PasswordMode::Ask);
        // Without Encrypt, current SQL Server drivers encrypt and verify.
        assert_eq!(parse_connection_url("Server=h;Database=x").unwrap().profile.tls.mode, TlsMode::Require);
        assert_eq!(parse_connection_url("Server=h;Encrypt=False").unwrap().profile.tls.mode, TlsMode::Disable);
        assert_eq!(parse_connection_url("Server=h;Encrypt=Strict").unwrap().profile.tls.mode, TlsMode::Require);

        let e = parse_connection_url("Server=h;Integrated Security=SSPI;Password=hunter2").unwrap_err();
        assert!(e.message.contains("Windows"), "{}", e.message);
        assert!(!e.message.contains("hunter2"));
        let e = parse_connection_url("Server=h\\SQLEXPRESS;Database=x").unwrap_err();
        assert!(e.message.contains("instance"), "{}", e.message);
        assert!(parse_connection_url("Server=h;Password={unclosed").is_err());
    }

    #[test]
    fn restore_points_are_on_unless_turned_off() {
        assert!(ConnectionProfile::new("a", Driver::Postgres).restore_points);
        let old = r#"{"id":"x","name":"n","driver":"postgres"}"#;
        let p: ConnectionProfile = serde_json::from_str(old).unwrap();
        assert!(p.restore_points, "profiles saved before restore points keep them");
        let off: ConnectionProfile =
            serde_json::from_str(r#"{"id":"x","name":"n","driver":"postgres","restorePoints":false}"#).unwrap();
        assert!(!off.restore_points);
    }

    #[test]
    fn parses_postgres_url_with_encoded_credentials() {
        let p = parse_connection_url(
            "postgresql://app%40corp:p%40ss%2Fw%3Ard@db.example.com:6543/my%20db?sslmode=verify-full",
        )
        .unwrap();
        assert_eq!(p.profile.driver, Driver::Postgres);
        assert_eq!(p.profile.user, "app@corp");
        assert_eq!(p.password.as_deref(), Some("p@ss/w:rd"));
        assert_eq!(p.profile.host, "db.example.com");
        assert_eq!(p.profile.port, Some(6543));
        assert_eq!(p.profile.database, "my db");
        assert_eq!(p.profile.tls.mode, TlsMode::Require);
        assert_eq!(p.profile.password_mode, PasswordMode::Keychain);
    }

    #[test]
    fn profile_serialization_never_contains_password() {
        let p = parse_connection_url("postgres://u:topsecret@h/db").unwrap();
        let json = serde_json::to_string(&p.profile).unwrap();
        assert!(!json.contains("topsecret"));
        assert!(!p.profile.to_url().contains("topsecret"));
    }

    #[test]
    fn parses_mysql_and_mariadb() {
        let p = parse_connection_url("mysql://root@127.0.0.1/shop?ssl-mode=DISABLED").unwrap();
        assert_eq!(p.profile.driver, Driver::Mysql);
        assert_eq!(p.profile.port, Some(3306));
        assert_eq!(p.profile.tls.mode, TlsMode::Disable);
        assert!(p.password.is_none());
        assert_eq!(p.profile.password_mode, PasswordMode::Ask);
        let p = parse_connection_url("mariadb://u:p@[::1]:3307/x").unwrap();
        assert_eq!(p.profile.driver, Driver::Mariadb);
        assert_eq!(p.profile.host, "::1");
        assert_eq!(p.profile.port, Some(3307));
    }

    #[test]
    fn libpq_require_does_not_claim_verification() {
        let p = parse_connection_url("postgres://h/db?sslmode=require").unwrap();
        assert_eq!(p.profile.tls.mode, TlsMode::RequireInsecure);
    }

    #[test]
    fn parses_sqlite_paths() {
        let p = parse_connection_url("sqlite:///home/me/data/app.db").unwrap();
        assert_eq!(p.profile.driver, Driver::Sqlite);
        assert_eq!(p.profile.file_path.as_deref(), Some("/home/me/data/app.db"));
        assert_eq!(p.profile.name, "app.db");
        let p = parse_connection_url("sqlite:C:/data/x.sqlite").unwrap();
        assert_eq!(p.profile.file_path.as_deref(), Some("C:/data/x.sqlite"));
    }

    #[test]
    fn parses_redis_urls() {
        let p = parse_connection_url("redis://cache.local:6380/2").unwrap();
        assert_eq!(p.profile.driver, Driver::Redis);
        assert_eq!(p.profile.port, Some(6380));
        assert_eq!(p.profile.database, "2");
        assert_eq!(p.profile.password_mode, PasswordMode::None);
        assert_eq!(p.profile.tls.mode, TlsMode::Disable);
        let p = parse_connection_url("rediss://:s3cret@cache.local/0").unwrap();
        assert_eq!(p.profile.port, Some(6379));
        assert_eq!(p.profile.tls.mode, TlsMode::Require);
        assert_eq!(p.password.as_deref(), Some("s3cret"));
    }

    #[test]
    fn parses_duckdb_paths() {
        let p = parse_connection_url("duckdb:///data/warehouse.duckdb").unwrap();
        assert_eq!(p.profile.driver, Driver::Duckdb);
        assert_eq!(p.profile.file_path.as_deref(), Some("/data/warehouse.duckdb"));
        assert!(p.profile.driver.is_file_based());
    }

    #[test]
    fn rejects_bad_urls_without_echoing_secrets() {
        let e = parse_connection_url("oracle://u:secretpw@h/db").unwrap_err();
        assert!(!e.message.contains("secretpw"));
        assert!(parse_connection_url("").is_err());
        assert!(parse_connection_url("postgres://h/db?sslmode=bogus").is_err());
        assert!(parse_connection_url("not a url").is_err());
    }

    #[test]
    fn validates_profiles() {
        let mut p = ConnectionProfile::new("x", Driver::Postgres);
        assert!(p.validate().is_ok());
        p.host = "bad host".into();
        assert!(p.validate().is_err());
        let mut s = ConnectionProfile::new("s", Driver::Sqlite);
        assert!(s.validate().is_err());
        s.file_path = Some("/tmp/x.db".into());
        assert!(s.validate().is_ok());
        let mut n = ConnectionProfile::new(" ", Driver::Mysql);
        assert!(n.validate().is_err());
        n.name = "ok".into();
        n.connect_timeout_secs = 0;
        assert!(n.validate().is_err());
    }

    #[test]
    fn profile_round_trips_through_json_with_defaults() {
        let json = r#"{"id":"1","name":"n","driver":"postgres"}"#;
        let p: ConnectionProfile = serde_json::from_str(json).unwrap();
        assert_eq!(p.connect_timeout_secs, 10);
        assert_eq!(p.safety_mode, SafetyMode::ConfirmDestructive);
        assert_eq!(p.tls.mode, TlsMode::Prefer);
    }
}

/// File format for sharing connection profiles. Never contains passwords or SSH secrets.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileBundle {
    pub format: String,
    pub version: u32,
    pub connections: Vec<ConnectionProfile>,
}

pub const PROFILE_BUNDLE_FORMAT: &str = "table-pro-max.connections";

impl ProfileBundle {
    pub fn new(connections: Vec<ConnectionProfile>) -> Self {
        Self { format: PROFILE_BUNDLE_FORMAT.into(), version: 1, connections }
    }

    /// Parses and validates a bundle. Imported profiles get fresh ids (so they never
    /// overwrite existing ones) and must ask for secrets until the user saves them.
    pub fn parse_for_import(json: &str) -> Result<Vec<ConnectionProfile>> {
        let bundle: ProfileBundle = serde_json::from_str(json)
            .map_err(|e| AppError::invalid_config(format!("Not a connection export file: {e}")))?;
        if bundle.format != PROFILE_BUNDLE_FORMAT {
            return Err(AppError::invalid_config("Not a Table Pro Max connection export file"));
        }
        if bundle.version != 1 {
            return Err(AppError::invalid_config("This export was made by a newer version of Table Pro Max"));
        }
        let mut out = Vec::with_capacity(bundle.connections.len());
        for mut p in bundle.connections {
            p.id = uuid::Uuid::new_v4().to_string();
            if p.password_mode == PasswordMode::Keychain {
                p.password_mode = PasswordMode::Ask;
            }
            if let Some(ssh) = p.ssh.as_mut()
                && ssh.secret_mode == PasswordMode::Keychain
            {
                ssh.secret_mode = PasswordMode::Ask;
            }
            p.validate()?;
            out.push(p);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod bundle_tests {
    use super::*;

    #[test]
    fn bundles_round_trip_without_secrets_and_with_new_ids() {
        let parsed = parse_connection_url("postgres://u:topsecret@db.example/app").unwrap();
        let json = serde_json::to_string(&ProfileBundle::new(vec![parsed.profile.clone()])).unwrap();
        assert!(!json.contains("topsecret"));
        let imported = ProfileBundle::parse_for_import(&json).unwrap();
        assert_eq!(imported.len(), 1);
        assert_ne!(imported[0].id, parsed.profile.id);
        assert_eq!(imported[0].host, "db.example");
        assert_eq!(imported[0].password_mode, PasswordMode::Ask, "no secret travels with the file");
    }

    #[test]
    fn rejects_foreign_files() {
        assert!(ProfileBundle::parse_for_import("{}").is_err());
        assert!(ProfileBundle::parse_for_import(r#"{"format":"x","version":1,"connections":[]}"#).is_err());
        assert!(
            ProfileBundle::parse_for_import(r#"{"format":"table-pro-max.connections","version":9,"connections":[]}"#)
                .is_err()
        );
        let bad = r#"{"format":"table-pro-max.connections","version":1,"connections":[{"id":"1","name":"","driver":"postgres"}]}"#;
        assert!(ProfileBundle::parse_for_import(bad).is_err(), "invalid profiles are refused");
    }
}
