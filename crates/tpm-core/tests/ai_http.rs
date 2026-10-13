//! AI client over real HTTP, against a fake OpenAI-compatible server on 127.0.0.1.
//! No external service is contacted unless `TPM_AI_LIVE_TLS=1` is set, in which case one
//! request with a deliberately invalid key goes to api.anthropic.com to check TLS.

use std::sync::Arc;

use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use tpm_core::ai::{self, AiConfig, AiRequest, AiTask};
use tpm_core::error::ErrorKind;

/// Serves one request with the given status and body; returns the raw request it received.
async fn serve_once(status: &'static str, body: String, delay_ms: u64) -> (String, tokio::task::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = sock.read(&mut chunk).await.unwrap();
            buf.extend_from_slice(&chunk[..n]);
            let text = String::from_utf8_lossy(&buf);
            if let Some(end) = text.find("\r\n\r\n") {
                let len = text[..end]
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                if buf.len() >= end + 4 + len {
                    break;
                }
            }
            if n == 0 {
                break;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        let resp = format!(
            "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = sock.write_all(resp.as_bytes()).await;
        String::from_utf8_lossy(&buf).into_owned()
    });
    (format!("http://{addr}/v1"), handle)
}

fn config(base_url: String) -> AiConfig {
    let mut s = serde_json::Map::new();
    s.insert("ai.enabled".into(), json!(true));
    s.insert("ai.provider".into(), json!("openai_compatible"));
    s.insert("ai.model".into(), json!("test-model"));
    s.insert("ai.baseUrl".into(), json!(base_url));
    AiConfig::from_settings(&s)
}

fn request() -> AiRequest {
    AiRequest {
        task: AiTask::Generate,
        dialect: "SQLite".into(),
        sql: String::new(),
        error: None,
        description: Some("newest five orders".into()),
        schema: Some("main.orders(id, created_at)".into()),
    }
}

#[tokio::test]
async fn openai_compatible_round_trip() {
    let body = json!({
        "model": "test-model",
        "choices": [{"message": {"role": "assistant", "content": "```sql\nSELECT * FROM orders ORDER BY created_at DESC LIMIT 5;\n```"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 42, "completion_tokens": 7}
    })
    .to_string();
    let (base, server) = serve_once("200 OK", body, 0).await;
    let cfg = config(base);
    let prompt = ai::build_prompt(&cfg, &request()).unwrap();
    let answer = ai::send(&cfg, &prompt, Some("local-key"), Arc::new(CancellationToken::new())).await.unwrap();
    assert_eq!(answer.sql.as_deref(), Some("SELECT * FROM orders ORDER BY created_at DESC LIMIT 5;"));
    assert_eq!(answer.input_tokens, Some(42));

    let raw = server.await.unwrap();
    assert!(raw.starts_with("POST /v1/chat/completions HTTP/1.1"));
    assert!(raw.to_ascii_lowercase().contains("authorization: bearer local-key"));
    // The body is exactly the previewed prompt: nothing else is added.
    let sent: serde_json::Value = serde_json::from_str(raw.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(sent["messages"][1]["content"], prompt.user);
    assert_eq!(sent["messages"][0]["content"], prompt.system);
}

#[tokio::test]
async fn errors_and_cancel() {
    let (base, _server) =
        serve_once("404 Not Found", json!({"error": "model 'test-model' not found"}).to_string(), 0).await;
    let cfg = config(base);
    let prompt = ai::build_prompt(&cfg, &request()).unwrap();
    let err = ai::send(&cfg, &prompt, None, Arc::new(CancellationToken::new())).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::InvalidConfig);
    assert!(err.detail.unwrap().contains("not found"));

    let (base, _server) = serve_once("200 OK", "{}".into(), 5_000).await;
    let cfg = config(base);
    let prompt = ai::build_prompt(&cfg, &request()).unwrap();
    let token = Arc::new(CancellationToken::new());
    let t = token.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        t.cancel();
    });
    let started = std::time::Instant::now();
    let err = ai::send(&cfg, &prompt, None, token).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Cancelled);
    assert!(started.elapsed() < std::time::Duration::from_secs(2));

    // Nothing listening: a clear network error.
    let cfg = config("http://127.0.0.1:9/v1".into());
    let prompt = ai::build_prompt(&cfg, &request()).unwrap();
    let err = ai::send(&cfg, &prompt, None, Arc::new(CancellationToken::new())).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Network);
}

#[tokio::test]
async fn live_tls_handshake_with_invalid_key() {
    if std::env::var("TPM_AI_LIVE_TLS").as_deref() != Ok("1") {
        eprintln!("skipped: set TPM_AI_LIVE_TLS=1 to contact api.anthropic.com");
        return;
    }
    let mut s = serde_json::Map::new();
    s.insert("ai.enabled".into(), json!(true));
    let cfg = AiConfig::from_settings(&s);
    let mut req = request();
    req.schema = None;
    req.description = Some("select one".into());
    let prompt = ai::build_prompt(&cfg, &req).unwrap();
    let err =
        ai::send(&cfg, &prompt, Some("sk-ant-invalid-test-key"), Arc::new(CancellationToken::new())).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Authentication, "{err:?}");
}
