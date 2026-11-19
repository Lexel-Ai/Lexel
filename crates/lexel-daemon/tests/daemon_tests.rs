use std::io::Cursor;
use std::sync::Arc;

use axum::http::{StatusCode, header};
use lexel_daemon::auth::{ensure_token, is_allowed_origin};
use lexel_daemon::http::build_router;
use lexel_daemon::native_messaging::{read_frame, write_frame};
use lexel_daemon::service::DaemonService;
use tokio::net::TcpListener;

#[test]
fn validates_loopback_and_extension_origins_only() {
    assert!(is_allowed_origin(None));
    assert!(is_allowed_origin(Some("http://127.0.0.1:5173")));
    assert!(is_allowed_origin(Some("http://localhost:4173")));
    assert!(is_allowed_origin(Some(
        "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
    )));
    assert!(is_allowed_origin(Some(
        "moz-extension://12345678-1234-1234-1234-1234567890ab"
    )));
    assert!(is_allowed_origin(Some("tauri://localhost")));

    assert!(!is_allowed_origin(Some("https://evil.example.com")));
    assert!(!is_allowed_origin(Some("http://192.168.1.5:5173")));
}

#[test]
fn native_messaging_frame_roundtrip_works() {
    let payload = br#"{"id":1,"kind":"health"}"#;
    let mut buf = Vec::new();
    write_frame(&mut buf, payload).expect("write frame");

    let mut cursor = Cursor::new(buf);
    let read_back = read_frame(&mut cursor)
        .expect("read frame")
        .expect("non-empty frame");
    assert_eq!(read_back, payload);
}

#[tokio::test]
async fn http_enforces_bearer_token_and_origin_and_syncs_profiles() {
    let tmp = std::env::temp_dir().join(format!("lexel-daemon-test-{}", uuid::Uuid::new_v4()));
    let models_dir = tmp.join("models");
    let token_path = tmp.join("daemon.token");
    std::fs::create_dir_all(&models_dir).unwrap();

    let token = ensure_token(&token_path).expect("token");
    let service = Arc::new(
        DaemonService::open_in_memory(tmp.clone(), models_dir, token_path, 42424).expect("service"),
    );

    let router = build_router(Arc::clone(&service), token.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    let client = reqwest::Client::new();
    let base = format!("http://{addr}");

    // Health succeeds without token.
    let health = client.get(format!("{base}/health")).send().await.unwrap();
    assert_eq!(health.status(), StatusCode::OK);

    // Extension auto-registration rejects non-extension Origin or invalid Chrome IDs.
    let bad_reg_origin = client
        .post(format!("{base}/v1/bridge/register-extension"))
        .header(header::ORIGIN, "http://127.0.0.1:5173")
        .send()
        .await
        .unwrap();
    assert_eq!(bad_reg_origin.status(), StatusCode::FORBIDDEN);

    let bad_chrome_id = client
        .post(format!("{base}/v1/bridge/register-extension"))
        .header(header::ORIGIN, "chrome-extension://not-a-valid-32-char-id")
        .send()
        .await
        .unwrap();
    assert_eq!(bad_chrome_id.status(), StatusCode::FORBIDDEN);

    // Protected route rejects missing token.
    let unauth = client
        .get(format!("{base}/v1/status"))
        .send()
        .await
        .unwrap();
    assert_eq!(unauth.status(), StatusCode::UNAUTHORIZED);

    // Protected route rejects untrusted Origin even with valid token.
    let bad_origin = client
        .get(format!("{base}/v1/status"))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::ORIGIN, "https://attacker.invalid")
        .send()
        .await
        .unwrap();
    assert_eq!(bad_origin.status(), StatusCode::FORBIDDEN);

    // Valid token + localhost origin succeeds.
    let ok_status = client
        .get(format!("{base}/v1/status"))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::ORIGIN, "http://127.0.0.1:5173")
        .send()
        .await
        .unwrap();
    assert_eq!(ok_status.status(), StatusCode::OK);
    let body: serde_json::Value = ok_status.json().await.unwrap();
    assert_eq!(body["activeProfile"]["name"], "Default");
    assert_eq!(body["models"].as_array().unwrap().len(), 2);

    // Switch main model to 0.5b via API.
    let switch_res = client
        .post(format!("{base}/v1/ai/main-model"))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .json(&serde_json::json!({ "model": "0.5b" }))
        .send()
        .await
        .unwrap();
    assert_eq!(switch_res.status(), StatusCode::OK);
    let switched: serde_json::Value = switch_res.json().await.unwrap();
    assert_eq!(
        switched["activeProfile"]["settings"]["mainModelTier"],
        "lexel-0.5b"
    );

    // Harper rules catalog endpoint returns curated rules.
    let rules_res = client
        .get(format!("{base}/v1/harper/rules"))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .send()
        .await
        .unwrap();
    assert_eq!(rules_res.status(), StatusCode::OK);
    let rules_json: serde_json::Value = rules_res.json().await.unwrap();
    assert!(rules_json["rules"].as_array().unwrap().len() > 100);

    // Tier 0 check flags slop, grammar, secrets, and returns safe fixes.
    let t0_res = client
        .post(format!("{base}/v1/tier0/check"))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .json(&serde_json::json!({
            "text": "This is an test to delve into sk-proj-abc1234567890abcdef123456 — fast.",
            "surfaceId": "web_reddit"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(t0_res.status(), StatusCode::OK);
    let t0_json: serde_json::Value = t0_res.json().await.unwrap();
    assert!(!t0_json["slop"].as_array().unwrap().is_empty());
    assert!(!t0_json["harper"].as_array().unwrap().is_empty());
    assert!(!t0_json["secrets"].as_array().unwrap().is_empty());
    assert!(t0_json["safeFixesCount"].as_u64().unwrap() >= 2);

    // Secrets block AI rewrite before touching local runtime.
    let blocked_rewrite = client
        .post(format!("{base}/v1/rewrite"))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .json(&serde_json::json!({
            "text": "Use key sk-proj-abc1234567890abcdef123456 to deploy.",
            "task": "fix_grammar_flow",
            "surfaceId": "general"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(blocked_rewrite.status(), StatusCode::FORBIDDEN);

    // Structured rules, Title Case, Fix Safe, and Synonyms endpoints.
    let struct_res = client
        .get(format!("{base}/v1/harper/structured-rules"))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .send()
        .await
        .unwrap();
    assert_eq!(struct_res.status(), StatusCode::OK);
    let struct_json: serde_json::Value = struct_res.json().await.unwrap();
    assert!(!struct_json["settings"].as_array().unwrap().is_empty());

    let tc_res = client
        .post(format!("{base}/v1/tier0/title-case"))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .json(&serde_json::json!({ "text": "fast local tools in rust" }))
        .send()
        .await
        .unwrap();
    assert_eq!(tc_res.status(), StatusCode::OK);
    let tc_json: serde_json::Value = tc_res.json().await.unwrap();
    assert_eq!(tc_json["text"], "Fast Local Tools in Rust");

    let fix_res = client
        .post(format!("{base}/v1/tier0/fix-safe"))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .json(&serde_json::json!({
            "text": "We must delve into this — utilize 🚀",
            "surfaceId": "web_reddit"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(fix_res.status(), StatusCode::OK);
    let fix_json: serde_json::Value = fix_res.json().await.unwrap();
    assert!(fix_json["fixesApplied"].as_u64().unwrap() >= 3);

    let syn_res = client
        .post(format!("{base}/v1/tier0/synonyms"))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .json(&serde_json::json!({ "word": "fast" }))
        .send()
        .await
        .unwrap();
    assert_eq!(syn_res.status(), StatusCode::OK);
    let syn_json: serde_json::Value = syn_res.json().await.unwrap();
    assert!(!syn_json["synonyms"].as_array().unwrap().is_empty());

    server.abort();
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn downloads_verifies_sha256_and_forwards_runtime_rpc_to_running_daemon() {
    use axum::{Router, routing::get};
    use lexel_core::ModelSpec;
    use lexel_daemon::models_fs::download_model_spec;
    use lexel_daemon::native_messaging::forward_rpc_to_loopback;
    use sha2::{Digest, Sha256};

    let tmp = std::env::temp_dir().join(format!("lexel-dl-test-{}", uuid::Uuid::new_v4()));
    let models_dir = tmp.join("models");
    let token_path = tmp.join("daemon.token");
    std::fs::create_dir_all(&models_dir).unwrap();

    let payload_bytes = b"mock-gguf-binary-weights-payload".to_vec();
    let expected_sha = {
        let digest = Sha256::digest(&payload_bytes);
        digest
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    };

    let bytes_clone = payload_bytes.clone();
    let file_router = Router::new().route(
        "/model.gguf",
        get(move || {
            let body = bytes_clone.clone();
            async move { body }
        }),
    );
    let dl_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let dl_addr = dl_listener.local_addr().unwrap();
    let dl_server = tokio::spawn(async move {
        let _ = axum::serve(dl_listener, file_router).await;
    });

    let valid_spec = ModelSpec {
        id: "lexel-0.5b".to_owned(),
        tier: "lite".to_owned(),
        label: "Mock 0.5B".to_owned(),
        description: "Test model".to_owned(),
        ollama_tag: "qwen2.5:0.5b".to_owned(),
        gguf_repo: "test/mock".to_owned(),
        gguf_filename: "mock-0.5b.gguf".to_owned(),
        gguf_url: format!("http://{dl_addr}/model.gguf"),
        sha256: expected_sha.clone(),
        size_bytes: payload_bytes.len() as u64,
        approx_ram_mb: 450,
    };

    // First download streams file and verifies SHA-256.
    let report = download_model_spec(&models_dir, &valid_spec)
        .await
        .expect("valid download");
    assert!(report.verified);
    assert!(!report.already_present);
    assert_eq!(report.sha256, expected_sha);

    // Second call skips download because verified file is already present.
    let cached = download_model_spec(&models_dir, &valid_spec)
        .await
        .expect("cached verify");
    assert!(cached.already_present);

    // Corrupt SHA-256 is rejected and never committed to disk.
    let bad_spec = ModelSpec {
        gguf_filename: "bad.gguf".to_owned(),
        sha256: "0000000000000000000000000000000000000000000000000000000000000000".to_owned(),
        ..valid_spec.clone()
    };
    let err = download_model_spec(&models_dir, &bad_spec)
        .await
        .expect_err("checksum mismatch must fail");
    assert!(err.contains("SHA-256 verification failed"));
    assert!(!models_dir.join("bad.gguf").exists());

    // Loopback forwarding reaches live daemon when up, fires state-change notifications on writes,
    // and returns None when down.
    let token = ensure_token(&token_path).expect("token");
    let service = Arc::new(
        DaemonService::open_in_memory(tmp.clone(), models_dir, token_path, 42424).expect("service"),
    );
    let notified = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let notified_clone = Arc::clone(&notified);
    let rpc_router = lexel_daemon::http::build_router_with_notifier(
        Arc::clone(&service),
        token.clone(),
        Some(Arc::new(move |kind: &str| {
            notified_clone.lock().unwrap().push(kind.to_owned());
        })),
    );
    let rpc_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let rpc_port = rpc_listener.local_addr().unwrap().port();
    let rpc_server = tokio::spawn(async move {
        let _ = axum::serve(rpc_listener, rpc_router).await;
    });

    let forwarded = forward_rpc_to_loopback(rpc_port, &token, "status", &serde_json::json!({}))
        .await
        .expect("daemon should answer")
        .expect("forwarded status ok");
    assert_eq!(forwarded["activeProfile"]["name"], "Default");

    let patched = forward_rpc_to_loopback(
        rpc_port,
        &token,
        "patchSettings",
        &serde_json::json!({ "patch": { "theme": "light", "dialect": 1 } }),
    )
    .await
    .expect("daemon should answer patchSettings")
    .expect("forwarded patchSettings ok");
    assert_eq!(patched["settings"]["theme"], "light");
    assert_eq!(patched["settings"]["dialect"], 1);
    assert!(notified.lock().unwrap().iter().any(|k| k == "settings"));

    rpc_server.abort();
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    assert!(
        forward_rpc_to_loopback(rpc_port, &token, "status", &serde_json::json!({}))
            .await
            .is_none()
    );

    dl_server.abort();
    let _ = std::fs::remove_dir_all(&tmp);
}
