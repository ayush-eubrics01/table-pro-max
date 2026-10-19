//! MongoDB support: a document browser with filters, aggregation pipelines, vector search and
//! deletes; not a relational adapter. See docs/superpowers/specs/2026-10-19-mongodb-design.md.
//!
//! MongoDB has no read-only session, so the surface itself is the boundary: reads (find,
//! aggregate without `$out`/`$merge`, vector search) and deletes, which read-only connections
//! refuse here. Filters and pipelines are parsed into BSON and sent as documents, never pasted
//! into anything.

use std::time::{Duration, Instant};

use futures_util::TryStreamExt;
use mongodb::Client;
use mongodb::bson::{Bson, Document, doc};
use mongodb::options::{ClientOptions, Credential, ServerAddress, Tls, TlsOptions};
use serde::{Deserialize, Serialize};

use crate::config::{ConnectionProfile, Environment, TlsMode};
use crate::error::{AppError, ErrorKind, Result};

/// Most documents a page or pipeline returns.
pub const MAX_PAGE: u32 = 1000;
/// Results stop growing past this many bytes of JSON; the page says so.
const MAX_RESULT_BYTES: usize = 16 * 1024 * 1024;
/// Top-level fields shown as table columns; the JSON keeps every one.
const MAX_FIELDS: usize = 100;
/// Reads stop on the server after this long when the connection sets no query timeout.
const DEFAULT_TIMEOUT_SECS: u64 = 30;
/// Most numbers in a vector search's query vector.
const MAX_DIMENSIONS: usize = 8192;
/// Atlas's own cap on `numCandidates`.
const MAX_CANDIDATES: u32 = 10_000;

pub struct MongoSession {
    client: Client,
    read_only: bool,
    writes_locked: bool,
    database: String,
    user: String,
    target: String,
    connection_name: String,
    environment: Environment,
    timeout: Duration,
    /// One operation at a time, as for every session in the app.
    op: tokio::sync::Mutex<()>,
    _tunnel: Option<crate::ssh::Tunnel>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoInfo {
    pub version: String,
    /// The database in the connection, if any: shown first and opened by default.
    pub database: String,
    pub user: String,
    pub target: String,
    pub read_only: bool,
    /// Opened read-only because it is production and writes aren't allowed yet.
    pub writes_locked: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoDatabase {
    pub name: String,
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoCollection {
    pub name: String,
    /// `collection`, `view` or `timeseries`.
    pub kind: String,
    pub estimated_count: Option<u64>,
}

/// Documents as relaxed Extended JSON, with each one's `_id` as compact Extended JSON (what a
/// delete by id sends back).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoPage {
    pub documents: Vec<String>,
    pub ids: Vec<Option<String>>,
    /// Top-level fields in order of first appearance, for a table view.
    pub fields: Vec<String>,
    /// More documents matched than were returned.
    pub has_more: bool,
    /// Stopped at the size limit.
    pub truncated: bool,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindRequest {
    pub database: String,
    pub collection: String,
    #[serde(default)]
    pub filter: String,
    #[serde(default)]
    pub sort: String,
    #[serde(default)]
    pub projection: String,
    #[serde(default)]
    pub skip: u64,
    pub limit: u32,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AggregateRequest {
    pub database: String,
    pub collection: String,
    pub pipeline: String,
    pub limit: u32,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorRequest {
    pub database: String,
    pub collection: String,
    pub index: String,
    pub path: String,
    /// A JSON array of numbers.
    pub query_vector: String,
    #[serde(default)]
    pub num_candidates: Option<u32>,
    pub limit: u32,
    #[serde(default)]
    pub filter: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DeleteTarget {
    /// Documents by `_id`, each as the compact Extended JSON a page returned.
    Ids { ids: Vec<String> },
    /// Every document a filter matches (`{}`: all of them).
    Filter { filter: String },
}

/// Parses a filter, sort or projection: JSON (MongoDB Extended JSON) for one object; empty means
/// `{}`.
pub fn parse_document(text: &str, what: &str) -> Result<Document> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(Document::new());
    }
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| AppError::invalid_config(format!("The {what} isn't valid JSON: {e}")))?;
    if !value.is_object() {
        return Err(AppError::invalid_config(format!(
            "The {what} must be a JSON object, such as {{ \"status\": \"paid\" }}"
        )));
    }
    match Bson::try_from(value) {
        Ok(Bson::Document(d)) => Ok(d),
        Ok(_) => Err(AppError::invalid_config(format!("The {what} must be a JSON object"))),
        Err(e) => Err(AppError::invalid_config(format!("The {what} isn't valid Extended JSON: {e}"))),
    }
}

/// A pipeline: a JSON array of stages. Stages that write (`$out`, `$merge`) are refused wherever
/// they appear: writes are out of scope.
pub fn parse_pipeline(text: &str) -> Result<Vec<Document>> {
    let value: serde_json::Value = serde_json::from_str(text.trim())
        .map_err(|e| AppError::invalid_config(format!("The pipeline isn't valid JSON: {e}")))?;
    let serde_json::Value::Array(stages) = value else {
        return Err(AppError::invalid_config(
            "A pipeline is a JSON array of stages, such as [{ \"$match\": { \"status\": \"paid\" } }]",
        ));
    };
    let mut out = Vec::with_capacity(stages.len());
    for (i, stage) in stages.into_iter().enumerate() {
        match Bson::try_from(stage) {
            Ok(Bson::Document(d)) => out.push(d),
            Ok(_) => return Err(AppError::invalid_config(format!("Stage {} must be a JSON object", i + 1))),
            Err(e) => return Err(AppError::invalid_config(format!("Stage {} isn't valid Extended JSON: {e}", i + 1))),
        }
    }
    if let Some(stage) = out.iter().find_map(|d| writing_stage(&Bson::Document(d.clone()))) {
        return Err(AppError::new(
            ErrorKind::PolicyViolation,
            format!("{stage} writes to a collection; only reading pipelines can run here"),
        ));
    }
    Ok(out)
}

/// `$out` or `$merge` anywhere in a value (sub-pipelines of `$facet`, `$lookup`, `$unionWith`).
fn writing_stage(value: &Bson) -> Option<&'static str> {
    match value {
        Bson::Document(d) => d.iter().find_map(|(k, v)| match k.as_str() {
            "$out" => Some("$out"),
            "$merge" => Some("$merge"),
            _ => writing_stage(v),
        }),
        Bson::Array(a) => a.iter().find_map(writing_stage),
        _ => None,
    }
}

/// The pipeline a vector search runs: `$vectorSearch`, then the score as `_score`.
pub fn vector_pipeline(req: &VectorRequest) -> Result<Vec<Document>> {
    let index = req.index.trim();
    let path = req.path.trim();
    if index.is_empty() || path.is_empty() {
        return Err(AppError::invalid_config("A vector search needs the index name and the vector field"));
    }
    if req.limit == 0 || req.limit > MAX_PAGE {
        return Err(AppError::invalid_config(format!("The limit must be between 1 and {MAX_PAGE}")));
    }
    let numbers: Vec<serde_json::Value> = match serde_json::from_str(req.query_vector.trim()) {
        Ok(serde_json::Value::Array(a)) => a,
        _ => {
            return Err(AppError::invalid_config(
                "The query vector must be a JSON array of numbers, such as [0.12, -0.4, 0.98]",
            ));
        }
    };
    if numbers.is_empty() || numbers.len() > MAX_DIMENSIONS {
        return Err(AppError::invalid_config(format!("The query vector needs between 1 and {MAX_DIMENSIONS} numbers")));
    }
    let mut vector = Vec::with_capacity(numbers.len());
    for (i, n) in numbers.iter().enumerate() {
        match n.as_f64().filter(|f| f.is_finite()) {
            Some(f) => vector.push(Bson::Double(f)),
            None => return Err(AppError::invalid_config(format!("Item {} of the query vector isn't a number", i + 1))),
        }
    }
    let candidates = req.num_candidates.unwrap_or_else(|| req.limit.saturating_mul(10).min(MAX_CANDIDATES));
    if candidates < req.limit || candidates > MAX_CANDIDATES {
        return Err(AppError::invalid_config(format!(
            "The number of candidates must be between the limit ({}) and {MAX_CANDIDATES}",
            req.limit
        )));
    }
    let mut search = doc! {
        "index": index,
        "path": path,
        "queryVector": vector,
        "numCandidates": i64::from(candidates),
        "limit": i64::from(req.limit),
    };
    let filter = parse_document(&req.filter, "filter")?;
    if !filter.is_empty() {
        search.insert("filter", filter);
    }
    Ok(vec![doc! { "$vectorSearch": search }, doc! { "$addFields": { "_score": { "$meta": "vectorSearchScore" } } }])
}

/// The filter a delete runs with.
pub fn delete_filter(target: &DeleteTarget) -> Result<Document> {
    match target {
        DeleteTarget::Filter { filter } => parse_document(filter, "filter"),
        DeleteTarget::Ids { ids } => {
            if ids.is_empty() {
                return Err(AppError::invalid_config("Select the documents to delete"));
            }
            let mut values = Vec::with_capacity(ids.len());
            for id in ids {
                let json: serde_json::Value = serde_json::from_str(id)
                    .map_err(|_| AppError::invalid_config("A document id isn't valid Extended JSON"))?;
                let value = Bson::try_from(json)
                    .map_err(|_| AppError::invalid_config("A document id isn't valid Extended JSON"))?;
                // Inside $in a regular expression is a pattern and could match any number of
                // documents; an `_id` is never an array, and `$` names are operators, not values.
                if !is_exact_id(&value) {
                    return Err(AppError::invalid_config(
                        "A document id must be a single value, not a pattern or an operator",
                    ));
                }
                values.push(value);
            }
            Ok(doc! { "_id": { "$in": values } })
        }
    }
}

fn is_exact_id(v: &Bson) -> bool {
    match v {
        Bson::RegularExpression(_) | Bson::Array(_) => false,
        Bson::Document(d) => d.iter().all(|(k, v)| !k.starts_with('$') && is_exact_id(v)),
        _ => true,
    }
}

/// The database a user signs in to: the profile's auth database, else for SRV (Atlas, whose
/// users live in admin) admin, else the connection's database, else admin.
pub fn auth_source(profile: &ConnectionProfile) -> String {
    let database = Some(profile.database.trim()).filter(|d| !d.is_empty() && !profile.srv);
    profile.auth_source.as_deref().map(str::trim).filter(|s| !s.is_empty()).or(database).unwrap_or("admin").to_string()
}

/// Routes this version can't take, refused before any tunnel is opened.
pub fn check_route(profile: &ConnectionProfile) -> Result<()> {
    if profile.ssh.is_none() {
        return Ok(());
    }
    if profile.srv {
        return Err(AppError::unsupported(
            "A mongodb+srv:// address can't go through an SSH tunnel; use the host and port of one server",
        ));
    }
    if profile.tls.mode == TlsMode::Require {
        return Err(AppError::unsupported(
            "Verified TLS through an SSH tunnel is not supported for MongoDB; use TLS without verification or no TLS",
        ));
    }
    Ok(())
}

/// The backend's rules for a delete, before anything is counted again or deleted: never on a
/// read-only connection; always confirmed; on production, a delete by filter (which may match
/// anything) also needs the connection name typed.
pub fn check_delete(
    read_only: bool,
    writes_locked: bool,
    environment: Environment,
    connection_name: &str,
    target: &DeleteTarget,
    confirmed: bool,
    typed: Option<&str>,
) -> Result<()> {
    if writes_locked {
        return Err(AppError::new(
            ErrorKind::PolicyViolation,
            "This production connection is read-only until you allow writes for this session",
        ));
    }
    if read_only {
        return Err(AppError::new(ErrorKind::PolicyViolation, "This connection is read-only"));
    }
    let needs_name = environment == Environment::Production && matches!(target, DeleteTarget::Filter { .. });
    if confirmed && (!needs_name || typed.map(str::trim) == Some(connection_name.trim())) {
        return Ok(());
    }
    let e = AppError::new(ErrorKind::ConfirmationRequired, format!("Confirm the delete on {connection_name}"));
    Err(if needs_name { e.with_code("confirm_typed") } else { e })
}

/// MongoDB keeps its own metadata in `system.*` collections; deleting from them is refused.
pub fn check_deletable_collection(database: &str, collection: &str) -> Result<()> {
    if matches!(database, "admin" | "config" | "local") {
        return Err(AppError::new(
            ErrorKind::PolicyViolation,
            format!("Documents in MongoDB's own {database} database can't be deleted here"),
        ));
    }
    if collection.starts_with("system.") {
        return Err(AppError::new(ErrorKind::PolicyViolation, "Documents in system collections can't be deleted here"));
    }
    Ok(())
}

fn to_text(d: Document) -> String {
    let json = Bson::Document(d).into_relaxed_extjson();
    serde_json::to_string_pretty(&json).unwrap_or_default()
}

fn id_text(d: &Document) -> Option<String> {
    d.get("_id").map(|id| id.clone().into_relaxed_extjson().to_string())
}

/// Builds a page from a cursor's documents: at most `limit`, and stops at the size limit.
async fn collect<C>(mut cursor: C, limit: u32, started: Instant) -> Result<MongoPage>
where
    C: futures_util::Stream<Item = mongodb::error::Result<Document>> + Unpin,
{
    let mut page = MongoPage::default();
    let mut bytes = 0usize;
    while let Some(d) = cursor.try_next().await.map_err(map_err)? {
        if page.documents.len() >= limit as usize {
            page.has_more = true;
            break;
        }
        let id = id_text(&d);
        let keys: Vec<String> = d.keys().cloned().collect();
        let text = to_text(d);
        // Stop before the document that would pass the limit; the first one always shows.
        if !page.documents.is_empty() && bytes + text.len() > MAX_RESULT_BYTES {
            page.truncated = true;
            break;
        }
        for key in keys {
            if page.fields.len() < MAX_FIELDS && !page.fields.contains(&key) {
                page.fields.push(key);
            }
        }
        bytes += text.len();
        page.documents.push(text);
        page.ids.push(id);
        if bytes >= MAX_RESULT_BYTES {
            page.truncated = true;
            break;
        }
    }
    page.duration_ms = started.elapsed().as_millis() as u64;
    Ok(page)
}

impl MongoSession {
    pub async fn connect(
        profile: &ConnectionProfile,
        password: Option<&str>,
        tunnel: Option<crate::ssh::Tunnel>,
        writes_locked: bool,
    ) -> Result<Self> {
        crate::adapters::tls::install_process_provider();
        check_route(profile)?;
        let connect_timeout = Duration::from_secs(profile.connect_timeout_secs);
        let mut opts = if profile.srv {
            // The hosts come from DNS (SRV and TXT records), as for Atlas.
            let url = format!("mongodb+srv://{}/", profile.host.trim());
            tokio::time::timeout(connect_timeout, ClientOptions::parse(url))
                .await
                .map_err(|_| AppError::new(ErrorKind::Network, "Looking up the server's address timed out"))?
                .map_err(map_err)?
        } else {
            let (host, port) = match &tunnel {
                Some(t) => ("127.0.0.1".to_string(), t.local_port),
                None => (profile.host.trim().to_string(), profile.port_or_default()),
            };
            let mut o = ClientOptions::default();
            o.hosts = vec![ServerAddress::Tcp { host, port: Some(port) }];
            // Through a tunnel there is one reachable address, whatever the replica set says.
            o.direct_connection = Some(tunnel.is_some() || profile.direct_connection);
            o
        };
        if !profile.user.trim().is_empty() {
            let source = auth_source(profile);
            opts.credential = Some(
                Credential::builder()
                    .username(profile.user.trim().to_string())
                    .password(password.map(str::to_string))
                    .source(source)
                    .build(),
            );
        }
        let ca = profile.tls.ca_cert_path.clone().filter(|p| !p.trim().is_empty()).map(std::path::PathBuf::from);
        let tls = |insecure: bool| {
            Tls::Enabled(
                TlsOptions::builder()
                    .allow_invalid_certificates(insecure.then_some(true))
                    .ca_file_path(ca.clone())
                    .build(),
            )
        };
        opts.tls = Some(match profile.tls.mode {
            TlsMode::Disable => Tls::Disabled,
            // MongoDB has no "TLS if offered": SRV (Atlas) means TLS, a plain host doesn't.
            TlsMode::Prefer if !profile.srv => Tls::Disabled,
            TlsMode::Prefer | TlsMode::Require => tls(false),
            TlsMode::RequireInsecure => tls(true),
        });
        opts.app_name = Some("Table Pro Max".into());
        opts.connect_timeout = Some(connect_timeout);
        opts.server_selection_timeout = Some(connect_timeout);
        let client = Client::with_options(opts).map_err(map_err)?;
        let read_only = profile.read_only() || writes_locked;
        let timeout = Duration::from_secs(if profile.query_timeout_secs > 0 {
            profile.query_timeout_secs
        } else {
            DEFAULT_TIMEOUT_SECS
        });
        let session = Self {
            client,
            read_only,
            writes_locked,
            database: profile.database.trim().to_string(),
            user: profile.user.trim().to_string(),
            target: profile.to_url(),
            connection_name: profile.name.clone(),
            environment: profile.environment,
            timeout,
            op: tokio::sync::Mutex::new(()),
            _tunnel: tunnel,
        };
        // Fail fast on a wrong address or password.
        session.timed(connect_timeout, session.client.database("admin").run_command(doc! { "ping": 1 })).await?;
        Ok(session)
    }

    async fn timed<T>(
        &self,
        limit: Duration,
        fut: impl std::future::IntoFuture<Output = mongodb::error::Result<T>>,
    ) -> Result<T> {
        match tokio::time::timeout(limit, fut.into_future()).await {
            Ok(r) => r.map_err(map_err),
            Err(_) => Err(AppError::timeout(limit.as_secs())),
        }
    }

    pub async fn info(&self) -> Result<MongoInfo> {
        let _op = self.op.lock().await;
        let build =
            self.timed(self.timeout, self.client.database("admin").run_command(doc! { "buildInfo": 1 })).await?;
        Ok(MongoInfo {
            version: build.get_str("version").unwrap_or_default().to_string(),
            database: self.database.clone(),
            user: self.user.clone(),
            target: self.target.clone(),
            read_only: self.read_only,
            writes_locked: self.writes_locked,
        })
    }

    pub async fn databases(&self) -> Result<Vec<MongoDatabase>> {
        let _op = self.op.lock().await;
        let specs = self.timed(self.timeout, self.client.list_databases().authorized_databases(true)).await;
        let mut out: Vec<MongoDatabase> = match specs {
            Ok(specs) => {
                specs.into_iter().map(|s| MongoDatabase { name: s.name, size_bytes: Some(s.size_on_disk) }).collect()
            }
            // A user who may not list databases can still use the one in the connection.
            Err(e) if !self.database.is_empty() && e.kind == ErrorKind::PolicyViolation => vec![],
            Err(e) => return Err(e),
        };
        if !self.database.is_empty() && !out.iter().any(|d| d.name == self.database) {
            out.push(MongoDatabase { name: self.database.clone(), size_bytes: None });
        }
        // The connection's database first, then user databases, then admin, config and local.
        let rank = |n: &str| {
            if n == self.database {
                0
            } else if matches!(n, "admin" | "config" | "local") {
                2
            } else {
                1
            }
        };
        out.sort_by(|a, b| rank(&a.name).cmp(&rank(&b.name)).then_with(|| a.name.cmp(&b.name)));
        Ok(out)
    }

    /// A light health check: the server answers `ping`.
    pub async fn ping(&self) -> Result<()> {
        // A session in the middle of an operation is alive; don't queue behind it.
        let Ok(_op) = self.op.try_lock() else { return Ok(()) };
        self.timed(PING_TIMEOUT, self.client.database("admin").run_command(doc! { "ping": 1 })).await.map(|_| ())
    }

    /// Collections and views, with estimated counts read within [`COUNTS_BUDGET`].
    pub async fn collections(&self, database: &str) -> Result<Vec<MongoCollection>> {
        self.collections_within(database, COUNTS_BUDGET).await
    }

    /// Collections and views; their estimated counts share `budget`, and once it is spent the
    /// rest are listed uncounted (a database with hundreds of collections still opens quickly).
    pub async fn collections_within(&self, database: &str, budget: Duration) -> Result<Vec<MongoCollection>> {
        let _op = self.op.lock().await;
        let started = Instant::now();
        let db = self.client.database(database);
        let specs: Vec<_> =
            self.timed(self.timeout, async { db.list_collections().await?.try_collect::<Vec<_>>().await }).await?;
        let mut out = Vec::with_capacity(specs.len());
        for s in specs {
            let kind = match s.collection_type {
                mongodb::results::CollectionType::View => "view",
                mongodb::results::CollectionType::Timeseries => "timeseries",
                _ => "collection",
            };
            // An estimate from metadata; skipped when slow, not allowed, or out of budget.
            let left = budget.saturating_sub(started.elapsed());
            let estimated_count = if kind == "collection" && !left.is_zero() {
                let c = db.collection::<Document>(&s.name);
                self.timed(left.min(Duration::from_secs(2)), c.estimated_document_count()).await.ok()
            } else {
                None
            };
            out.push(MongoCollection { name: s.name, kind: kind.into(), estimated_count });
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    pub async fn find(&self, req: &FindRequest) -> Result<MongoPage> {
        let _op = self.op.lock().await;
        let limit = check_limit(req.limit)?;
        let filter = parse_document(&req.filter, "filter")?;
        let sort = parse_document(&req.sort, "sort")?;
        let projection = parse_document(&req.projection, "projection")?;
        let started = Instant::now();
        let coll = self.client.database(&req.database).collection::<Document>(&req.collection);
        let mut find = coll.find(filter).skip(req.skip).limit(i64::from(limit) + 1).max_time(self.timeout);
        if !sort.is_empty() {
            find = find.sort(sort);
        }
        if !projection.is_empty() {
            find = find.projection(projection);
        }
        // One deadline for opening the cursor and reading the page.
        tokio::time::timeout(self.timeout, async { collect(find.await.map_err(map_err)?, limit, started).await })
            .await
            .map_err(|_| AppError::timeout(self.timeout.as_secs()))?
    }

    pub async fn count(&self, database: &str, collection: &str, filter: &str) -> Result<u64> {
        let _op = self.op.lock().await;
        let filter = parse_document(filter, "filter")?;
        let coll = self.client.database(database).collection::<Document>(collection);
        self.timed(self.timeout, coll.count_documents(filter).max_time(self.timeout)).await
    }

    pub async fn aggregate(&self, req: &AggregateRequest) -> Result<MongoPage> {
        let mut pipeline = parse_pipeline(&req.pipeline)?;
        self.run_pipeline(&req.database, &req.collection, &mut pipeline, req.limit).await
    }

    pub async fn vector_search(&self, req: &VectorRequest) -> Result<MongoPage> {
        let mut pipeline = vector_pipeline(req)?;
        self.run_pipeline(&req.database, &req.collection, &mut pipeline, req.limit).await
    }

    async fn run_pipeline(
        &self,
        database: &str,
        collection: &str,
        pipeline: &mut Vec<Document>,
        limit: u32,
    ) -> Result<MongoPage> {
        let _op = self.op.lock().await;
        let limit = check_limit(limit)?;
        // One more than the page, to know whether there are more.
        pipeline.push(doc! { "$limit": i64::from(limit) + 1 });
        let started = Instant::now();
        let coll = self.client.database(database).collection::<Document>(collection);
        let aggregate = coll.aggregate(pipeline.clone()).max_time(self.timeout);
        tokio::time::timeout(self.timeout, async { collect(aggregate.await.map_err(map_err)?, limit, started).await })
            .await
            .map_err(|_| AppError::timeout(self.timeout.as_secs()))?
    }

    /// How many documents a delete would remove.
    pub async fn delete_count(&self, database: &str, collection: &str, target: &DeleteTarget) -> Result<u64> {
        let _op = self.op.lock().await;
        check_deletable_collection(database, collection)?;
        let filter = delete_filter(target)?;
        let coll = self.client.database(database).collection::<Document>(collection);
        self.timed(self.timeout, coll.count_documents(filter).max_time(self.timeout)).await
    }

    /// Deletes what the target matches, after the backend's checks; `expected` is the count the
    /// confirmation showed. Exactly the documents counted now are deleted: a different count stops
    /// the delete, and a document that starts matching meanwhile is left alone.
    pub async fn delete(
        &self,
        database: &str,
        collection: &str,
        target: &DeleteTarget,
        expected: u64,
        confirmed: bool,
        typed: Option<&str>,
    ) -> Result<u64> {
        self.check(target, confirmed, typed)?;
        // Both halves under one hold of the session.
        let _op = self.op.lock().await;
        let ids = self.ids_to_delete(database, collection, target, expected).await?;
        self.delete_ids(database, collection, target, &ids, confirmed, typed).await
    }

    fn check(&self, target: &DeleteTarget, confirmed: bool, typed: Option<&str>) -> Result<()> {
        check_delete(
            self.read_only,
            self.writes_locked,
            self.environment,
            &self.connection_name,
            target,
            confirmed,
            typed,
        )
    }

    /// The first half of [`Self::delete`]: the `_id`s of the documents the target matches, when
    /// there are exactly `expected` of them (at most [`MAX_FILTER_DELETE`]).
    pub async fn matching_ids(
        &self,
        database: &str,
        collection: &str,
        target: &DeleteTarget,
        expected: u64,
    ) -> Result<Vec<Bson>> {
        let _op = self.op.lock().await;
        self.ids_to_delete(database, collection, target, expected).await
    }

    async fn ids_to_delete(
        &self,
        database: &str,
        collection: &str,
        target: &DeleteTarget,
        expected: u64,
    ) -> Result<Vec<Bson>> {
        check_deletable_collection(database, collection)?;
        if expected > MAX_FILTER_DELETE {
            return Err(AppError::invalid_config(format!(
                "A delete can remove at most {MAX_FILTER_DELETE} documents at once; narrow the filter and delete in parts"
            )));
        }
        let filter = delete_filter(target)?;
        let coll = self.client.database(database).collection::<Document>(collection);
        // One more than expected, to tell "more match now" apart.
        let limit = i64::try_from(expected.saturating_add(1)).unwrap_or(i64::MAX);
        let find = coll.find(filter).projection(doc! { "_id": 1 }).limit(limit).max_time(self.timeout);
        let mut cursor = self.timed(self.timeout, find).await?;
        let mut ids = Vec::new();
        let read = async {
            while let Some(d) = cursor.try_next().await.map_err(map_err)? {
                if let Some(id) = d.get("_id") {
                    ids.push(id.clone());
                }
            }
            Ok::<_, AppError>(())
        };
        tokio::time::timeout(self.timeout, read).await.map_err(|_| {
            AppError::new(ErrorKind::Timeout, "Reading the documents to delete timed out. Nothing was deleted.")
        })??;
        let found = ids.len() as u64;
        if found != expected {
            let now = if found > expected { format!("More than {expected}") } else { found.to_string() };
            return Err(AppError::new(
                ErrorKind::Conflict,
                format!("{now} documents match now, not the {expected} you confirmed. Nothing was deleted."),
            ));
        }
        Ok(ids)
    }

    /// The second half of [`Self::delete`]: deletes the documents with these `_id`s that still
    /// match the target, after the same checks. Returns how many were deleted.
    pub async fn delete_matching(
        &self,
        database: &str,
        collection: &str,
        target: &DeleteTarget,
        ids: &[Bson],
        confirmed: bool,
        typed: Option<&str>,
    ) -> Result<u64> {
        let _op = self.op.lock().await;
        self.delete_ids(database, collection, target, ids, confirmed, typed).await
    }

    async fn delete_ids(
        &self,
        database: &str,
        collection: &str,
        target: &DeleteTarget,
        ids: &[Bson],
        confirmed: bool,
        typed: Option<&str>,
    ) -> Result<u64> {
        self.check(target, confirmed, typed)?;
        check_deletable_collection(database, collection)?;
        let filter = delete_filter(target)?;
        let coll = self.client.database(database).collection::<Document>(collection);
        let mut deleted = 0;
        for batch in ids.chunks(DELETE_BATCH) {
            let exact = doc! { "$and": [filter.clone(), { "_id": { "$in": batch.to_vec() } }] };
            match self.timed(self.timeout, coll.delete_many(exact)).await {
                Ok(r) => deleted += r.deleted_count,
                // The server keeps going with a batch the client stopped waiting for (deletes take
                // no time limit), so say what may have happened instead of "nothing was deleted".
                Err(e) => {
                    return Err(e.add_context(format!(
                        "{deleted} of {} documents were deleted before this; up to {} more may have been deleted on \
                         the server. Count again before deleting the rest.",
                        ids.len(),
                        batch.len()
                    )));
                }
            }
        }
        Ok(deleted)
    }
}

/// How long the health check waits for `ping`.
const PING_TIMEOUT: Duration = Duration::from_secs(5);
/// Time for all of a database's estimated counts together.
const COUNTS_BUDGET: Duration = Duration::from_secs(3);

/// Most documents one delete removes: their `_id`s are read first, to delete exactly those.
pub const MAX_FILTER_DELETE: u64 = 1_000_000;
/// `_id`s per delete command.
const DELETE_BATCH: usize = 10_000;

fn check_limit(limit: u32) -> Result<u32> {
    if limit == 0 || limit > MAX_PAGE {
        return Err(AppError::invalid_config(format!("The limit must be between 1 and {MAX_PAGE}")));
    }
    Ok(limit)
}

fn map_err(e: mongodb::error::Error) -> AppError {
    use mongodb::error::ErrorKind as K;
    let message = e.to_string();
    let kind = match e.kind.as_ref() {
        K::Authentication { .. } => ErrorKind::Authentication,
        K::ServerSelection { .. } | K::Io(_) | K::ConnectionPoolCleared { .. } | K::DnsResolve { .. } => {
            ErrorKind::Network
        }
        K::InvalidArgument { .. } | K::InvalidTlsConfig { .. } => ErrorKind::InvalidConfig,
        K::Command(c) => match c.code {
            // Unauthorized
            13 => ErrorKind::PolicyViolation,
            // MaxTimeMSExpired
            50 => ErrorKind::Timeout,
            _ => ErrorKind::Database,
        },
        _ => ErrorKind::Database,
    };
    AppError::new(kind, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_page_stops_before_the_document_that_would_pass_the_size_limit() {
        let big = |i: i32| Ok(doc! { "_id": i, "text": "x".repeat(MAX_RESULT_BYTES / 2 + 1) });
        let page = collect(futures_util::stream::iter(vec![big(1), big(2), big(3)]), 10, Instant::now()).await.unwrap();
        assert_eq!(page.documents.len(), 1, "the second would pass 16 MB");
        assert!(page.truncated);
        assert!(page.documents.iter().map(String::len).sum::<usize>() <= MAX_RESULT_BYTES);
        // One document larger than the limit still shows, alone.
        let huge = Ok(doc! { "_id": 0, "text": "x".repeat(MAX_RESULT_BYTES + 10) });
        let page = collect(futures_util::stream::iter(vec![huge, big(1)]), 10, Instant::now()).await.unwrap();
        assert_eq!((page.documents.len(), page.truncated), (1, true));
    }

    #[test]
    fn system_collections_are_never_deleted_from() {
        let e = check_deletable_collection("shop", "system.views").unwrap_err();
        assert_eq!(e.kind, ErrorKind::PolicyViolation);
        assert!(check_deletable_collection("shop", "system.profile").is_err());
        assert!(check_deletable_collection("shop", "orders").is_ok());
        assert!(check_deletable_collection("shop", "my.system.log").is_ok());
        // MongoDB's own databases: sessions, sharding metadata, the oplog.
        for db in ["admin", "config", "local"] {
            assert_eq!(check_deletable_collection(db, "transactions").unwrap_err().kind, ErrorKind::PolicyViolation);
        }
    }

    #[test]
    fn ids_that_would_match_more_than_one_value_are_refused() {
        // Inside $in a regular expression is a pattern: it could match every document, without
        // the typed confirmation a filter needs on production.
        for id in [
            r#"{"$regularExpression":{"pattern":"","options":""}}"#,
            r#"[1, 2]"#,
            r#"{"$gt": 0}"#,
            r#"{"a": {"$ne": 1}}"#,
        ] {
            let e = delete_filter(&DeleteTarget::Ids { ids: vec![id.into()] }).unwrap_err();
            assert_eq!(e.kind, ErrorKind::InvalidConfig, "{id}");
        }
        for id in [
            r#"{"$oid":"65f1a2b3c4d5e6f708091a2b"}"#,
            "7",
            r#""abc""#,
            r#"{"a": 1, "b": {"c": 2}}"#,
            r#"{"$numberLong":"9007199254740993"}"#,
        ] {
            assert!(delete_filter(&DeleteTarget::Ids { ids: vec![id.into()] }).is_ok(), "{id}");
        }
    }

    #[test]
    fn the_auth_database_follows_the_profile_then_atlas() {
        let mut p = crate::config::parse_connection_url("mongodb://u@db.example.com/shop").unwrap().profile;
        assert_eq!(auth_source(&p), "shop");
        p.auth_source = Some("users".into());
        assert_eq!(auth_source(&p), "users");
        // SRV (Atlas) names users in admin; the database in the address is only the default one.
        p.auth_source = None;
        p.srv = true;
        assert_eq!(auth_source(&p), "admin");
        p.srv = false;
        p.database = " ".into();
        assert_eq!(auth_source(&p), "admin");
    }

    #[test]
    fn filters_are_extended_json_objects() {
        let d =
            parse_document(r#"{ "status": "paid", "_id": { "$oid": "65f1a2b3c4d5e6f708091a2b" } }"#, "filter").unwrap();
        assert_eq!(d.get_str("status").unwrap(), "paid");
        assert!(matches!(d.get("_id"), Some(Bson::ObjectId(_))));
        assert!(parse_document("  ", "filter").unwrap().is_empty());
        assert!(parse_document("[1]", "filter").unwrap_err().message.contains("JSON object"));
        assert!(parse_document("{ status: 1 }", "sort").unwrap_err().message.contains("valid JSON"));
        let date = parse_document(r#"{ "at": { "$gte": { "$date": "2024-01-02T00:00:00Z" } } }"#, "filter").unwrap();
        assert!(matches!(date.get_document("at").unwrap().get("$gte"), Some(Bson::DateTime(_))));
    }

    #[test]
    fn pipelines_only_read() {
        let p =
            parse_pipeline(r#"[{ "$match": { "a": 1 } }, { "$group": { "_id": "$b", "n": { "$sum": 1 } } }]"#).unwrap();
        assert_eq!(p.len(), 2);
        for writes in [
            r#"[{ "$out": "copy" }]"#,
            r#"[{ "$match": {} }, { "$merge": { "into": "x" } }]"#,
            r#"[{ "$facet": { "a": [{ "$out": "y" }] } }]"#,
            r#"[{ "$lookup": { "from": "b", "pipeline": [{ "$merge": "z" }], "as": "c" } }]"#,
        ] {
            assert_eq!(parse_pipeline(writes).unwrap_err().kind, ErrorKind::PolicyViolation, "{writes}");
        }
        assert!(parse_pipeline(r#"{ "$match": {} }"#).unwrap_err().message.contains("JSON array"));
        assert!(parse_pipeline("[1]").unwrap_err().message.contains("Stage 1"));
    }

    fn vreq() -> VectorRequest {
        VectorRequest {
            database: "db".into(),
            collection: "docs".into(),
            index: "vidx".into(),
            path: "embedding".into(),
            query_vector: "[0.5, -1, 2e-3]".into(),
            num_candidates: None,
            limit: 5,
            filter: String::new(),
        }
    }

    #[test]
    fn vector_search_stages_are_built_and_checked() {
        let p = vector_pipeline(&vreq()).unwrap();
        let s = p[0].get_document("$vectorSearch").unwrap();
        assert_eq!((s.get_str("index").unwrap(), s.get_str("path").unwrap()), ("vidx", "embedding"));
        assert_eq!(
            s.get_array("queryVector").unwrap(),
            &vec![Bson::Double(0.5), Bson::Double(-1.0), Bson::Double(0.002)]
        );
        assert_eq!((s.get_i64("numCandidates").unwrap(), s.get_i64("limit").unwrap()), (50, 5));
        assert!(s.get("filter").is_none());
        assert_eq!(p[1], doc! { "$addFields": { "_score": { "$meta": "vectorSearchScore" } } });
        let filtered = vector_pipeline(&VectorRequest { filter: r#"{ "lang": "en" }"#.into(), ..vreq() }).unwrap();
        assert_eq!(
            filtered[0].get_document("$vectorSearch").unwrap().get_document("filter").unwrap(),
            &doc! { "lang": "en" }
        );
        for (bad, why) in [
            (VectorRequest { query_vector: "[]".into(), ..vreq() }, "between 1"),
            (VectorRequest { query_vector: "[1, \"x\"]".into(), ..vreq() }, "Item 2"),
            (VectorRequest { query_vector: "1, 2".into(), ..vreq() }, "JSON array"),
            (VectorRequest { index: " ".into(), ..vreq() }, "index name"),
            (VectorRequest { num_candidates: Some(2), ..vreq() }, "candidates"),
            (VectorRequest { limit: 0, ..vreq() }, "limit"),
        ] {
            let e = vector_pipeline(&bad).unwrap_err();
            assert!(e.message.contains(why), "{why}: {}", e.message);
        }
    }

    #[test]
    fn deletes_are_checked_in_the_backend() {
        let ids = DeleteTarget::Ids {
            ids: vec![r#"{"$oid":"65f1a2b3c4d5e6f708091a2b"}"#.into(), "7".into(), r#""a""#.into()],
        };
        let f = delete_filter(&ids).unwrap();
        let ids_in = f.get_document("_id").unwrap().get_array("$in").unwrap();
        assert!(matches!(ids_in[0], Bson::ObjectId(_)));
        assert_eq!((ids_in.len(), &ids_in[2]), (3, &Bson::String("a".into())));
        assert!(delete_filter(&DeleteTarget::Ids { ids: vec![] }).is_err());
        let all = DeleteTarget::Filter { filter: String::new() };
        assert!(delete_filter(&all).unwrap().is_empty(), "an empty filter is every document");

        let check = |ro, locked, env, target: &DeleteTarget, confirmed, typed| {
            check_delete(ro, locked, env, "Shop prod", target, confirmed, typed)
        };
        let local = Environment::Local;
        let prod = Environment::Production;
        assert_eq!(check(true, false, local, &ids, true, None).unwrap_err().kind, ErrorKind::PolicyViolation);
        assert_eq!(check(false, true, prod, &ids, true, None).unwrap_err().kind, ErrorKind::PolicyViolation);
        assert_eq!(check(false, false, local, &ids, false, None).unwrap_err().kind, ErrorKind::ConfirmationRequired);
        assert!(check(false, false, local, &ids, true, None).is_ok());
        assert!(check(false, false, prod, &ids, true, None).is_ok(), "selected documents: a click on production");
        let e = check(false, false, prod, &all, true, None).unwrap_err();
        assert_eq!((e.kind, e.code.as_deref()), (ErrorKind::ConfirmationRequired, Some("confirm_typed")));
        assert!(check(false, false, prod, &all, true, Some("wrong")).is_err());
        assert!(check(false, false, prod, &all, true, Some(" Shop prod ")).is_ok());
    }
}
