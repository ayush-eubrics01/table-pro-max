//! Optional AI assistance: explain SQL, explain an error, suggest improvements, or draft
//! SQL from a description.
//!
//! Off by default. Nothing is sent until the user enables it, configures a provider and
//! sends a specific request whose exact text they have been shown (`build_prompt` is what
//! the UI previews and what `send` transmits). Only the SQL, error text, description and
//! optional table/column names the user chose are sent. Row data is never included, and
//! returned SQL is only ever inserted into the editor, never executed.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::config::{TlsConfig, TlsMode};
use crate::error::{AppError, ErrorKind, Result};

pub const ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com";
pub const ANTHROPIC_DEFAULT_MODEL: &str = "claude-opus-5-5";
pub const OLLAMA_BASE_URL: &str = "http://127.0.0.1:11434/v1";
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Refusal fallback routing on Anthropic's own endpoint (models that support it).
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
const FALLBACK_MODELS: &[&str] = &["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"];
const MAX_TOKENS: u32 = 16_000;
/// Upper bound on what one request may send, so a huge script or schema is refused
/// rather than silently uploaded or truncated.
pub const MAX_PROMPT_BYTES: usize = 200_000;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiProvider {
    Anthropic,
    /// Any server exposing `/chat/completions` (Ollama, LM Studio, llama.cpp, vLLM, …).
    OpenaiCompatible,
}

impl AiProvider {
    pub fn key_account(self) -> &'static str {
        match self {
            AiProvider::Anthropic => "ai:anthropic:api-key",
            AiProvider::OpenaiCompatible => "ai:openai-compatible:api-key",
        }
    }
}

/// AI configuration as stored in the settings table (`ai.*` keys).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    pub enabled: bool,
    pub provider: AiProvider,
    pub model: String,
    pub base_url: String,
}

impl AiConfig {
    pub fn from_settings(settings: &serde_json::Map<String, Value>) -> Self {
        let text = |k: &str| settings.get(k).and_then(Value::as_str).map(str::trim).unwrap_or("").to_string();
        let provider = match text("ai.provider").as_str() {
            "openai_compatible" => AiProvider::OpenaiCompatible,
            _ => AiProvider::Anthropic,
        };
        let mut model = text("ai.model");
        let mut base_url = text("ai.baseUrl");
        if provider == AiProvider::Anthropic {
            if model.is_empty() {
                model = ANTHROPIC_DEFAULT_MODEL.into();
            }
            if base_url.is_empty() {
                base_url = ANTHROPIC_BASE_URL.into();
            }
        } else if base_url.is_empty() {
            base_url = OLLAMA_BASE_URL.into();
        }
        AiConfig {
            enabled: settings.get("ai.enabled").and_then(Value::as_bool).unwrap_or(false),
            provider,
            model,
            base_url,
        }
    }

    /// The URL requests are posted to. Plain `http` is only accepted for this machine.
    pub fn endpoint(&self) -> Result<url::Url> {
        let base = url::Url::parse(self.base_url.trim_end_matches('/'))
            .map_err(|e| AppError::invalid_config(format!("Invalid AI endpoint URL: {e}")))?;
        if !base.username().is_empty() || base.password().is_some() {
            return Err(AppError::invalid_config("Put the API key in the key field, not in the endpoint URL"));
        }
        let loopback = match base.host() {
            Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            None => false,
        };
        match base.scheme() {
            "https" => {}
            "http" if loopback => {}
            "http" => {
                return Err(AppError::invalid_config(
                    "Plain http is only allowed for a model server on this machine (localhost). Use https.",
                ));
            }
            other => return Err(AppError::invalid_config(format!("Unsupported AI endpoint scheme: {other}"))),
        }
        let path = match self.provider {
            AiProvider::Anthropic => "/v1/messages",
            AiProvider::OpenaiCompatible => "/chat/completions",
        };
        let joined = format!("{}{}", base.as_str().trim_end_matches('/'), path);
        url::Url::parse(&joined).map_err(|e| AppError::invalid_config(format!("Invalid AI endpoint URL: {e}")))
    }

    fn uses_anthropic_fallbacks(&self) -> bool {
        self.provider == AiProvider::Anthropic
            && self.base_url.trim_end_matches('/') == ANTHROPIC_BASE_URL
            && FALLBACK_MODELS.contains(&self.model.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiTask {
    Explain,
    ExplainError,
    Improve,
    Generate,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRequest {
    pub task: AiTask,
    /// Human-readable SQL dialect, e.g. "PostgreSQL 16".
    pub dialect: String,
    #[serde(default)]
    pub sql: String,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// Table and column names the user chose to include; never row data.
    #[serde(default)]
    pub schema: Option<String>,
}

/// Exactly what will be sent, shown to the user before sending.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiPrompt {
    pub endpoint: String,
    pub model: String,
    pub system: String,
    pub user: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAnswer {
    pub text: String,
    /// The first SQL code block of the answer, for "Insert into editor".
    pub sql: Option<String>,
    pub model: String,
    /// The answer hit the output limit and is incomplete.
    pub truncated: bool,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

pub fn build_prompt(config: &AiConfig, req: &AiRequest) -> Result<AiPrompt> {
    if config.model.trim().is_empty() {
        return Err(AppError::invalid_config("Choose a model in Settings → AI assistant"));
    }
    let endpoint = config.endpoint()?;
    let dialect = if req.dialect.trim().is_empty() { "SQL" } else { req.dialect.trim() };
    let system = format!(
        "You are a SQL assistant inside a desktop database client. The user's database is {dialect}. \
         Answer concisely in plain Markdown. When you give SQL the user may run, put it in a single \
         ```sql fenced block. You cannot see the data and you never run anything; the user decides \
         whether to run your SQL. If a statement you suggest modifies or deletes data or schema, say so \
         plainly."
    );
    let sql = req.sql.trim();
    let need_sql = |what: &str| {
        if sql.is_empty() { Err(AppError::invalid_config(format!("There is no SQL to {what}"))) } else { Ok(()) }
    };
    let mut user = match req.task {
        AiTask::Explain => {
            need_sql("explain")?;
            format!(
                "Explain what this query does, step by step. Point out anything surprising, such as NULL \
                 handling, implicit conversions, locking or likely performance problems.\n\n```sql\n{sql}\n```"
            )
        }
        AiTask::ExplainError => {
            need_sql("diagnose")?;
            let error = req
                .error
                .as_deref()
                .map(str::trim)
                .filter(|e| !e.is_empty())
                .ok_or_else(|| AppError::invalid_config("There is no error message to explain"))?;
            format!(
                "This statement failed. Explain the cause in a few sentences and give a corrected statement.\n\n\
                 Error:\n{error}\n\n```sql\n{sql}\n```"
            )
        }
        AiTask::Improve => {
            need_sql("improve")?;
            format!(
                "Suggest improvements to this query for correctness, readability and performance. Give the \
                 revised query in one ```sql block, then list the changes and why. Keep the results identical \
                 unless a change fixes a bug, and say so if it does.\n\n```sql\n{sql}\n```"
            )
        }
        AiTask::Generate => {
            let description = req
                .description
                .as_deref()
                .map(str::trim)
                .filter(|d| !d.is_empty())
                .ok_or_else(|| AppError::invalid_config("Describe what the query should do"))?;
            let mut s = format!(
                "Write a {dialect} query for this request. Return one ```sql block followed by a short \
                 explanation. Use only tables and columns from the schema below if one is given; if something \
                 needed is missing, say so instead of inventing names.\n\nRequest:\n{description}"
            );
            if !sql.is_empty() {
                s.push_str(&format!("\n\nCurrent editor contents, for context:\n```sql\n{sql}\n```"));
            }
            s
        }
    };
    if let Some(schema) = req.schema.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        user.push_str(&format!("\n\nSchema (table and column names only):\n{schema}"));
    }
    if system.len() + user.len() > MAX_PROMPT_BYTES {
        return Err(AppError::invalid_config(format!(
            "The request is too large to send ({} KB, limit {} KB). Select a smaller part of the script or \
             leave out the schema.",
            (system.len() + user.len()) / 1024,
            MAX_PROMPT_BYTES / 1024
        )));
    }
    Ok(AiPrompt { endpoint: endpoint.to_string(), model: config.model.clone(), system, user })
}

/// Request body and extra headers for a provider. Pure, so it is unit-tested.
pub fn request_body(config: &AiConfig, prompt: &AiPrompt) -> (Value, Vec<(&'static str, &'static str)>) {
    match config.provider {
        AiProvider::Anthropic => {
            let mut body = json!({
                "model": prompt.model,
                "max_tokens": MAX_TOKENS,
                "system": prompt.system,
                "messages": [{ "role": "user", "content": prompt.user }],
            });
            let mut headers = vec![("anthropic-version", ANTHROPIC_VERSION)];
            if config.uses_anthropic_fallbacks() {
                body["fallbacks"] = json!("default");
                headers.push(("anthropic-beta", FALLBACK_BETA));
            }
            (body, headers)
        }
        AiProvider::OpenaiCompatible => (
            json!({
                "model": prompt.model,
                "stream": false,
                "messages": [
                    { "role": "system", "content": prompt.system },
                    { "role": "user", "content": prompt.user },
                ],
            }),
            Vec::new(),
        ),
    }
}

/// Parses a successful (HTTP 2xx) response body.
pub fn parse_response(provider: AiProvider, body: &Value) -> Result<AiAnswer> {
    let bad = || AppError::new(ErrorKind::Serialization, "The AI service returned an unexpected response");
    let (text, model, truncated, input_tokens, output_tokens) = match provider {
        AiProvider::Anthropic => {
            let stop = body.get("stop_reason").and_then(Value::as_str).unwrap_or("");
            if stop == "refusal" {
                let why = body
                    .pointer("/stop_details/explanation")
                    .and_then(Value::as_str)
                    .unwrap_or("The model declined this request.");
                return Err(
                    AppError::new(ErrorKind::PolicyViolation, "The AI model declined to answer").with_detail(why)
                );
            }
            let blocks = body.get("content").and_then(Value::as_array).ok_or_else(bad)?;
            let text: Vec<&str> = blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect();
            (
                text.join(""),
                body.get("model").and_then(Value::as_str).unwrap_or("").to_string(),
                stop == "max_tokens",
                body.pointer("/usage/input_tokens").and_then(Value::as_u64),
                body.pointer("/usage/output_tokens").and_then(Value::as_u64),
            )
        }
        AiProvider::OpenaiCompatible => {
            let choice = body.pointer("/choices/0").ok_or_else(bad)?;
            (
                choice.pointer("/message/content").and_then(Value::as_str).ok_or_else(bad)?.to_string(),
                body.get("model").and_then(Value::as_str).unwrap_or("").to_string(),
                choice.get("finish_reason").and_then(Value::as_str) == Some("length"),
                body.pointer("/usage/prompt_tokens").and_then(Value::as_u64),
                body.pointer("/usage/completion_tokens").and_then(Value::as_u64),
            )
        }
    };
    if text.trim().is_empty() {
        return Err(AppError::new(ErrorKind::Serialization, "The AI service returned an empty answer"));
    }
    let sql = extract_sql(&text);
    Ok(AiAnswer { text, sql, model, truncated, input_tokens, output_tokens })
}

/// Maps an HTTP error status and body to an `AppError`. The body is the provider's error
/// object, which never contains the request or the key.
pub fn http_error(status: u16, body: &str) -> AppError {
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v.pointer("/error/message")
                .or_else(|| v.get("error").filter(|e| e.is_string()))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.chars().take(300).collect());
    let (kind, summary) = match status {
        401 | 403 => (ErrorKind::Authentication, "The AI service rejected the API key"),
        404 => (ErrorKind::InvalidConfig, "The AI endpoint or model was not found"),
        408 | 504 => (ErrorKind::Timeout, "The AI service timed out"),
        429 => (ErrorKind::Network, "The AI service is rate limiting requests; try again shortly"),
        529 => (ErrorKind::Network, "The AI service is overloaded; try again shortly"),
        400..=499 => (ErrorKind::InvalidConfig, "The AI service rejected the request"),
        _ => (ErrorKind::Network, "The AI service returned an error"),
    };
    let err = AppError::new(kind, summary).with_code(format!("ai_http_{status}"));
    if message.trim().is_empty() { err } else { err.with_detail(message) }
}

/// First fenced code block, preferring one tagged `sql`.
pub fn extract_sql(text: &str) -> Option<String> {
    let mut blocks: Vec<(String, String)> = Vec::new();
    let mut lines = text.lines();
    while let Some(line) = lines.next() {
        let trimmed = line.trim_start();
        let Some(info) = trimmed.strip_prefix("```") else { continue };
        let lang = info.trim().to_ascii_lowercase();
        let mut body = Vec::new();
        for inner in lines.by_ref() {
            if inner.trim_start().starts_with("```") {
                break;
            }
            body.push(inner);
        }
        blocks.push((lang, body.join("\n")));
    }
    let pick = blocks
        .iter()
        .find(|(lang, _)| lang == "sql" || lang.ends_with("sql"))
        .or_else(|| blocks.iter().find(|(lang, _)| lang.is_empty()))?;
    let sql = pick.1.trim();
    (!sql.is_empty()).then(|| sql.to_string())
}

fn http_client() -> Result<reqwest::Client> {
    let mut tls = crate::adapters::tls::client_config(&TlsConfig { mode: TlsMode::Require, ca_cert_path: None })?;
    tls.alpn_protocols = vec![b"http/1.1".to_vec()];
    reqwest::Client::builder()
        .tls_backend_preconfigured(tls)
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(Duration::from_secs(15))
        .user_agent(concat!("TableProMax/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| AppError::internal(format!("Could not create the HTTP client: {e}")))
}

/// Sends a prompt that `build_prompt` produced (and the user has seen).
pub async fn send(
    config: &AiConfig,
    prompt: &AiPrompt,
    api_key: Option<&str>,
    cancel: Arc<CancellationToken>,
) -> Result<AiAnswer> {
    if !config.enabled {
        return Err(AppError::new(ErrorKind::PolicyViolation, "AI assistance is turned off in Settings"));
    }
    // The prompt must match the current configuration, so a stale preview is never sent elsewhere.
    let expected = config.endpoint()?.to_string();
    if prompt.endpoint != expected || prompt.model != config.model {
        return Err(AppError::invalid_config("AI settings changed since the preview; review the request again"));
    }
    let key = api_key.map(str::trim).filter(|k| !k.is_empty());
    if config.provider == AiProvider::Anthropic && key.is_none() {
        return Err(AppError::new(ErrorKind::Authentication, "Add an Anthropic API key in Settings → AI assistant")
            .with_code("ai_key_required"));
    }
    let (body, headers) = request_body(config, prompt);
    let mut req = http_client()?.post(&expected).json(&body);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    if let Some(key) = key {
        req = match config.provider {
            AiProvider::Anthropic => req.header("x-api-key", key),
            AiProvider::OpenaiCompatible => req.bearer_auth(key),
        };
    }
    let work = async {
        let resp = req.send().await.map_err(transport_error)?;
        let status = resp.status();
        let text = resp.text().await.map_err(transport_error)?;
        if !status.is_success() {
            return Err(http_error(status.as_u16(), &text));
        }
        let value: Value = serde_json::from_str(&text)
            .map_err(|_| AppError::new(ErrorKind::Serialization, "The AI service returned an unexpected response"))?;
        parse_response(config.provider, &value)
    };
    tokio::select! {
        r = work => r,
        _ = cancel.cancelled() => Err(AppError::cancelled()),
    }
}

fn transport_error(e: reqwest::Error) -> AppError {
    // reqwest errors include the URL (never the key, which is a header).
    if e.is_timeout() {
        AppError::new(ErrorKind::Timeout, "The AI service did not answer in time")
    } else if e.is_connect() {
        AppError::new(ErrorKind::Network, "Could not reach the AI service").with_detail(error_chain(&e))
    } else {
        AppError::new(ErrorKind::Network, "The AI request failed").with_detail(error_chain(&e))
    }
}

fn error_chain(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut source = e.source();
    while let Some(s) = source {
        out.push_str(": ");
        out.push_str(&s.to_string());
        source = s.source();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(pairs: &[(&str, Value)]) -> serde_json::Map<String, Value> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    fn anthropic() -> AiConfig {
        AiConfig::from_settings(&settings(&[("ai.enabled", json!(true))]))
    }

    fn req(task: AiTask) -> AiRequest {
        AiRequest {
            task,
            dialect: "PostgreSQL 16".into(),
            sql: "select * from users where id = 1".into(),
            error: None,
            description: None,
            schema: None,
        }
    }

    #[test]
    fn defaults_are_off_and_anthropic() {
        let c = AiConfig::from_settings(&serde_json::Map::new());
        assert!(!c.enabled);
        assert_eq!(c.provider, AiProvider::Anthropic);
        assert_eq!(c.model, ANTHROPIC_DEFAULT_MODEL);
        assert_eq!(c.endpoint().unwrap().as_str(), "https://api.anthropic.com/v1/messages");
        let o = AiConfig::from_settings(&settings(&[
            ("ai.provider", json!("openai_compatible")),
            ("ai.model", json!("qwen2.5-coder")),
        ]));
        assert_eq!(o.endpoint().unwrap().as_str(), "http://127.0.0.1:11434/v1/chat/completions");
    }

    #[test]
    fn endpoint_rules() {
        let mut c = anthropic();
        for ok in ["https://proxy.example.com/", "http://localhost:8080", "http://[::1]:1234", "http://127.0.0.1"] {
            c.base_url = ok.into();
            assert!(c.endpoint().is_ok(), "{ok}");
        }
        for bad in ["http://10.0.0.5:11434", "ftp://x", "https://user:pw@example.com", "not a url"] {
            c.base_url = bad.into();
            assert!(c.endpoint().is_err(), "{bad}");
        }
    }

    #[test]
    fn prompts_contain_only_what_was_given() {
        let c = anthropic();
        let p = build_prompt(&c, &req(AiTask::Explain)).unwrap();
        assert!(p.system.contains("PostgreSQL 16"));
        assert!(p.user.contains("select * from users where id = 1"));
        assert!(!p.user.contains("Schema"));

        let mut r = req(AiTask::Generate);
        r.description = Some("count users per day".into());
        r.schema = Some("public.users(id, created_at)".into());
        let p = build_prompt(&c, &r).unwrap();
        assert!(p.user.contains("count users per day") && p.user.contains("public.users(id, created_at)"));

        let mut r = req(AiTask::ExplainError);
        assert!(build_prompt(&c, &r).is_err(), "error text is required");
        r.error = Some("column \"x\" does not exist".into());
        assert!(build_prompt(&c, &r).unwrap().user.contains("does not exist"));

        let mut r = req(AiTask::Improve);
        r.sql = "  ".into();
        assert!(build_prompt(&c, &r).is_err());
        r.sql = "x".repeat(MAX_PROMPT_BYTES);
        assert!(build_prompt(&c, &r).is_err(), "oversized requests are refused, not truncated");
    }

    #[test]
    fn request_shapes() {
        let c = anthropic();
        let p = build_prompt(&c, &req(AiTask::Explain)).unwrap();
        let (body, headers) = request_body(&c, &p);
        assert_eq!(body["model"], "claude-opus-5-5");
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["fallbacks"], "default");
        assert!(headers.contains(&("anthropic-beta", FALLBACK_BETA)));

        let mut proxy = c.clone();
        proxy.base_url = "https://proxy.example.com".into();
        let (body, headers) = request_body(&proxy, &build_prompt(&proxy, &req(AiTask::Explain)).unwrap());
        assert!(body.get("fallbacks").is_none() && headers.len() == 1);

        let o = AiConfig::from_settings(&settings(&[
            ("ai.provider", json!("openai_compatible")),
            ("ai.model", json!("m")),
        ]));
        let (body, _) = request_body(&o, &build_prompt(&o, &req(AiTask::Explain)).unwrap());
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["stream"], false);
    }

    #[test]
    fn parses_responses() {
        let a = json!({
            "model": "claude-opus-5-5",
            "stop_reason": "end_turn",
            "content": [
                {"type": "thinking", "thinking": ""},
                {"type": "text", "text": "Use this:\n```sql\nSELECT 1;\n```\nDone."}
            ],
            "usage": {"input_tokens": 10, "output_tokens": 5}
        });
        let r = parse_response(AiProvider::Anthropic, &a).unwrap();
        assert_eq!(r.sql.as_deref(), Some("SELECT 1;"));
        assert_eq!(r.output_tokens, Some(5));
        assert!(!r.truncated);

        let refusal = json!({"stop_reason": "refusal", "content": [], "stop_details": {"explanation": "no"}});
        assert_eq!(parse_response(AiProvider::Anthropic, &refusal).unwrap_err().kind, ErrorKind::PolicyViolation);

        let o = json!({"model": "m", "choices": [{"message": {"content": "plain"}, "finish_reason": "length"}]});
        let r = parse_response(AiProvider::OpenaiCompatible, &o).unwrap();
        assert!(r.truncated && r.sql.is_none());
        assert!(parse_response(AiProvider::OpenaiCompatible, &json!({})).is_err());
    }

    #[test]
    fn extracts_sql_blocks() {
        assert_eq!(extract_sql("a\n```\nselect 2\n```").as_deref(), Some("select 2"));
        assert_eq!(extract_sql("```text\nx\n```\n```sql\nselect 3\n```").as_deref(), Some("select 3"));
        assert_eq!(extract_sql("```postgresql\nselect 4\n```").as_deref(), Some("select 4"));
        assert_eq!(extract_sql("no code"), None);
    }

    #[test]
    fn http_errors_are_classified() {
        let e = http_error(
            401,
            r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#,
        );
        assert_eq!(e.kind, ErrorKind::Authentication);
        assert_eq!(e.detail.as_deref(), Some("invalid x-api-key"));
        assert_eq!(http_error(404, r#"{"error":"model 'q' not found"}"#).kind, ErrorKind::InvalidConfig);
        assert_eq!(http_error(529, "").kind, ErrorKind::Network);
    }

    #[tokio::test]
    async fn disabled_or_stale_requests_are_not_sent() {
        let mut c = anthropic();
        let p = build_prompt(&c, &req(AiTask::Explain)).unwrap();
        let token = Arc::new(CancellationToken::new());
        c.enabled = false;
        assert!(send(&c, &p, Some("k"), token.clone()).await.is_err());
        c.enabled = true;
        assert_eq!(send(&c, &p, None, token.clone()).await.unwrap_err().code.as_deref(), Some("ai_key_required"));
        c.model = "other".into();
        assert!(send(&c, &p, Some("k"), token).await.is_err());
    }
}
