use std::io::Cursor;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine as _;
use lexel_daemon::auth::ensure_token;
use lexel_daemon::http::build_router;
use lexel_daemon::native_messaging::{forward_rewrite_stream_to_loopback, read_frame};
use lexel_daemon::service::DaemonService;
use tokio::net::TcpListener;
use tokio::sync::Mutex;

#[derive(Clone)]
struct MockAiState {
    calls: Arc<AtomicUsize>,
    seen_bodies: Arc<Mutex<Vec<serde_json::Value>>>,
    mode: Arc<Mutex<String>>,
}

async fn start_mock_ai_server() -> (String, MockAiState, tokio::task::JoinHandle<()>) {
    let state = MockAiState {
        calls: Arc::new(AtomicUsize::new(0)),
        seen_bodies: Arc::new(Mutex::new(Vec::new())),
        mode: Arc::new(Mutex::new("clean".to_owned())),
    };

    let router = Router::new()
        .route(
            "/v1/models",
            get(|| async { Json(serde_json::json!({ "data": [{ "id": "mock-local-1.5b" }] })) }),
        )
        .route("/v1/chat/completions", post(handle_mock_chat))
        .with_state(state.clone());

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    (format!("http://{addr}"), state, handle)
}

async fn handle_mock_chat(
    State(state): State<MockAiState>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let call_num = state.calls.fetch_add(1, Ordering::SeqCst);
    state.seen_bodies.lock().await.push(body.clone());
    let mode = state.mode.lock().await.clone();
    let is_stream = body
        .get("stream")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let reply = match mode.as_str() {
        "retry_repair" => {
            if call_num == 0 {
                // Pass 1 intentionally fails Tier 2 (em dash + slop + dropped metric).
                "Let's delve into this — latency dropped nicely.".to_owned()
            } else {
                // Pass 2 repair satisfies all Tier 2 gates.
                "Latency dropped 42% on PR #19 after caching.".to_owned()
            }
        }
        "redact_echo" => {
            "Use [LEXEL_REDACTED_1] and contact [LEXEL_REDACTED_2] for staging.".to_owned()
        }
        "two_takes" => {
            let sys = body
                .pointer("/messages/0/content")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if sys.contains("Ultra-Short") {
                "Fixed #42 cache bug in 12ms.".to_owned()
            } else {
                "We fixed the cache invalidation bug in #42 and cut latency to 12ms.".to_owned()
            }
        }
        "ghost_clean" => "clearing stale keys on write.".to_owned(),
        "ghost_slop" => "leveraging a pivotal seamless tapestry.".to_owned(),
        "ghost_hallucinated_num" => "cutting p99 latency by 94% overnight.".to_owned(),
        _ => "Fixed the cache timeout in PR #42.".to_owned(),
    };

    if is_stream {
        let words: Vec<&str> = reply.split_inclusive(' ').collect();
        let mut sse = String::new();
        for w in words {
            let chunk = serde_json::json!({
                "choices": [{ "delta": { "content": w } }],
                "timings": { "predicted_per_second": 28.5 }
            });
            sse.push_str(&format!("data: {chunk}\n\n"));
        }
        sse.push_str("data: [DONE]\n\n");
        ([(header::CONTENT_TYPE, "text/event-stream")], sse).into_response()
    } else {
        Json(serde_json::json!({
            "choices": [{ "message": { "content": reply } }],
            "timings": { "predicted_per_second": 24.75 }
        }))
        .into_response()
    }
}

async fn start_test_daemon(
    mock_ai_endpoint: &str,
) -> (
    String,
    String,
    Arc<DaemonService>,
    std::path::PathBuf,
    tokio::task::JoinHandle<()>,
) {
    let tmp = std::env::temp_dir().join(format!("lexel-v02-test-{}", uuid::Uuid::new_v4()));
    let models_dir = tmp.join("models");
    let token_path = tmp.join("daemon.token");
    std::fs::create_dir_all(&models_dir).unwrap();

    let token = ensure_token(&token_path).expect("token");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let service = Arc::new(
        DaemonService::open_in_memory(tmp.clone(), models_dir, token_path, addr.port())
            .expect("service"),
    );

    service
        .patch_settings(serde_json::json!({
            "aiEnabled": true,
            "runtime": "openai_compat",
            "openaiCompatEndpoint": mock_ai_endpoint,
            "customModel": "mock-local-1.5b",
            "mainModelTier": "custom"
        }))
        .expect("configure openai_compat runtime");

    let router = build_router(Arc::clone(&service), token.clone());
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    (format!("http://{addr}"), token, service, tmp, handle)
}

#[tokio::test]
async fn tier0_fast_path_bypasses_llm_for_deterministic_deslop() {
    let (mock_url, mock_state, mock_srv) = start_mock_ai_server().await;
    let (base, token, _svc, tmp, daemon_srv) = start_test_daemon(&mock_url).await;
    let client = reqwest::Client::new();

    let res = client
        .post(format!("{base}/v1/rewrite"))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .json(&serde_json::json!({
            "text": "We should delve into this — utilize fast local checks.",
            "task": "deslop",
            "surfaceId": "general"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["fastPath"], true);
    assert_eq!(body["model"], "tier0-deterministic");
    assert_eq!(body["gates"]["zeroSlop"], true);
    assert!(!body["suggestion"].as_str().unwrap().contains("delve"));
    assert!(!body["suggestion"].as_str().unwrap().contains('—'));
    // Confirm the LLM was never called.
    assert_eq!(mock_state.calls.load(Ordering::SeqCst), 0);

    daemon_srv.abort();
    mock_srv.abort();
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn tier2_guided_retry_repairs_failed_pass1_and_records_metadata() {
    let (mock_url, mock_state, mock_srv) = start_mock_ai_server().await;
    *mock_state.mode.lock().await = "retry_repair".to_owned();
    let (base, token, _svc, tmp, daemon_srv) = start_test_daemon(&mock_url).await;
    let client = reqwest::Client::new();

    let res = client
        .post(format!("{base}/v1/rewrite"))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .json(&serde_json::json!({
            "text": "Latency dropped 42% on PR #19 after adding caching.",
            "task": "rewrite_surface",
            "surfaceId": "web_github_pr"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["fastPath"], false);
    assert_eq!(body["retried"], true);
    assert!(!body["failedConstraints"].as_array().unwrap().is_empty());
    assert_eq!(body["gates"]["zeroSlop"], true);
    assert_eq!(body["gates"]["numbersPreserved"], true);
    assert_eq!(
        body["suggestion"],
        "Latency dropped 42% on PR #19 after caching."
    );
    assert_eq!(mock_state.calls.load(Ordering::SeqCst), 2);

    // Confirm cache_prompt: true was sent on requests.
    let bodies = mock_state.seen_bodies.lock().await;
    assert_eq!(bodies[0]["cache_prompt"], true);

    daemon_srv.abort();
    mock_srv.abort();
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn streaming_sse_and_native_messaging_chunks_work_end_to_end() {
    let (mock_url, _mock_state, mock_srv) = start_mock_ai_server().await;
    let (base, token, svc, tmp, daemon_srv) = start_test_daemon(&mock_url).await;
    let client = reqwest::Client::new();

    // 1. Direct HTTP SSE endpoint
    let sse_res = client
        .post(format!("{base}/v1/rewrite/stream"))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .json(&serde_json::json!({
            "text": "We fixed the cache timeout in PR #42.",
            "task": "direct",
            "surfaceId": "web_github_pr"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(sse_res.status(), StatusCode::OK);
    let sse_text = sse_res.text().await.unwrap();
    assert!(sse_text.contains("event: chunk"));
    assert!(sse_text.contains("event: complete"));
    assert!(sse_text.contains("Fixed the cache timeout in PR #42."));

    // 2. Native Messaging chunk frame forwarding
    let mut framed_out = Vec::new();
    let forwarded = forward_rewrite_stream_to_loopback(
        svc.http_port,
        &token,
        &Some(serde_json::json!("stream-42")),
        &serde_json::json!({
            "text": "We fixed the cache timeout in PR #42.",
            "task": "direct",
            "surfaceId": "web_github_pr"
        }),
        &mut framed_out,
    )
    .await
    .expect("daemon reachable");
    forwarded.expect("stream frames written");

    let mut cursor = Cursor::new(framed_out);
    let mut chunk_count = 0usize;
    let mut done_frame: Option<serde_json::Value> = None;
    while let Some(raw) = read_frame(&mut cursor).unwrap() {
        let msg: serde_json::Value = serde_json::from_slice(&raw).unwrap();
        assert_eq!(msg["id"], "stream-42");
        assert_eq!(msg["stream"], true);
        if msg["done"] == false {
            chunk_count += 1;
        } else if msg["done"] == true {
            done_frame = Some(msg);
        }
    }
    assert!(chunk_count >= 1);
    let terminal = done_frame.expect("terminal frame");
    assert_eq!(terminal["ok"], true);
    assert_eq!(
        terminal["data"]["suggestion"],
        "Fixed the cache timeout in PR #42."
    );

    daemon_srv.abort();
    mock_srv.abort();
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn redact_and_restore_hides_secrets_from_ai_and_restores_cleanly() {
    let (mock_url, mock_state, mock_srv) = start_mock_ai_server().await;
    *mock_state.mode.lock().await = "redact_echo".to_owned();
    let (base, token, _svc, tmp, daemon_srv) = start_test_daemon(&mock_url).await;
    let client = reqwest::Client::new();

    // Preview endpoint
    let preview = client
        .post(format!("{base}/v1/tier0/redact-preview"))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .json(&serde_json::json!({
            "text": "Key AKIAIOSFODNN7EXAMPLE belongs to alice@example.com."
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(preview.status(), StatusCode::OK);
    let pjson: serde_json::Value = preview.json().await.unwrap();
    assert_eq!(pjson["redactedCount"], 2);
    assert!(
        !pjson["redactedText"]
            .as_str()
            .unwrap()
            .contains("AKIAIOSFODNN7EXAMPLE")
    );

    // Rewrite with opt-in redactSecrets: true
    let res = client
        .post(format!("{base}/v1/rewrite"))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .json(&serde_json::json!({
            "text": "Use AKIAIOSFODNN7EXAMPLE and email alice@example.com for staging.",
            "task": "rewrite_surface",
            "surfaceId": "general",
            "redactSecrets": true
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["redactedCount"], 2);
    assert_eq!(body["restoredCleanly"], true);
    assert_eq!(
        body["suggestion"],
        "Use AKIAIOSFODNN7EXAMPLE and contact alice@example.com for staging."
    );

    // Verify raw secrets were NEVER sent to the model backend.
    let sent = serde_json::to_string(&*mock_state.seen_bodies.lock().await).unwrap();
    assert!(!sent.contains("AKIAIOSFODNN7EXAMPLE"));
    assert!(!sent.contains("alice@example.com"));
    assert!(sent.contains("[LEXEL_REDACTED_1]"));
    assert!(sent.contains("[LEXEL_REDACTED_2]"));

    daemon_srv.abort();
    mock_srv.abort();
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn two_takes_ghost_complete_context_scope_snippets_transcribe_doctor_and_db_rpcs() {
    let (mock_url, mock_state, mock_srv) = start_mock_ai_server().await;
    *mock_state.mode.lock().await = "two_takes".to_owned();
    let (base, token, _svc, tmp, daemon_srv) = start_test_daemon(&mock_url).await;
    let client = reqwest::Client::new();

    // 1. 2 takes mode
    let takes_res = client
        .post(format!("{base}/v1/rewrite"))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .json(&serde_json::json!({
            "text": "We fixed the cache invalidation bug in #42 and latency dropped to 12ms.",
            "task": "rewrite_surface",
            "surfaceId": "web_x",
            "candidates": 2
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(takes_res.status(), StatusCode::OK);
    let takes_json: serde_json::Value = takes_res.json().await.unwrap();
    let cands = takes_json["candidates"].as_array().unwrap();
    assert_eq!(cands.len(), 2);
    assert_eq!(cands[0]["label"], "Direct");
    assert_eq!(cands[1]["label"], "Ultra-Short");

    // 2. Ghost-text completion (clean + fail-safe slop suppression)
    *mock_state.mode.lock().await = "ghost_clean".to_owned();
    let comp_ok = client
        .post(format!("{base}/v1/complete"))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .json(&serde_json::json!({
            "prefix": "We fixed the cache invalidation bug by ",
            "surfaceId": "web_github_pr",
            "maxTokens": 20
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(comp_ok.status(), StatusCode::OK);
    let comp_json: serde_json::Value = comp_ok.json().await.unwrap();
    assert_eq!(comp_json["completion"], "clearing stale keys on write.");
    assert_eq!(comp_json["gates"]["zeroSlop"], true);

    *mock_state.mode.lock().await = "ghost_slop".to_owned();
    let comp_slop = client
        .post(format!("{base}/v1/complete"))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .json(&serde_json::json!({
            "prefix": "We fixed the cache invalidation bug by ",
            "surfaceId": "web_github_pr"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(comp_slop.status(), StatusCode::OK);
    let comp_slop_json: serde_json::Value = comp_slop.json().await.unwrap();
    let cleaned_comp = comp_slop_json["completion"].as_str().unwrap();
    assert!(!cleaned_comp.contains("leveraging"));
    assert!(!cleaned_comp.contains("tapestry"));
    assert_eq!(comp_slop_json["gates"]["zeroSlop"], true);

    *mock_state.mode.lock().await = "ghost_hallucinated_num".to_owned();
    let comp_num = client
        .post(format!("{base}/v1/complete"))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .json(&serde_json::json!({
            "prefix": "We fixed the cache invalidation bug by ",
            "surfaceId": "web_github_pr"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(comp_num.status(), StatusCode::OK);
    let comp_num_json: serde_json::Value = comp_num.json().await.unwrap();
    assert_eq!(comp_num_json["completion"], "");
    assert_eq!(comp_num_json["gates"]["numbersPreserved"], false);

    // 3. Smart thread context scoper
    let long_ctx = (0..15)
        .map(|i| {
            format!(
                "Block {i}: Routine discussion about unrelated quarterly planning and catering logistics in office room {i}."
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let scope_res = client
        .post(format!("{base}/v1/context/scope"))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .json(&serde_json::json!({
            "source": "Check room 12 logistics.",
            "threadContext": long_ctx,
            "maxTokens": 80
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(scope_res.status(), StatusCode::OK);
    let scope_json: serde_json::Value = scope_res.json().await.unwrap();
    assert_eq!(scope_json["truncated"], true);
    assert!(scope_json["estimatedTokens"].as_u64().unwrap() <= 80);

    // 4. Context-aware snippets
    let snips = client
        .get(format!("{base}/v1/snippets"))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .send()
        .await
        .unwrap();
    assert_eq!(snips.status(), StatusCode::OK);
    let snips_json: serde_json::Value = snips.json().await.unwrap();
    assert!(snips_json["snippets"].as_array().unwrap().len() >= 5);

    let expanded = client
        .post(format!("{base}/v1/snippets/expand"))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .json(&serde_json::json!({
            "trigger": "/lgtm",
            "surfaceId": "web_github_pr",
            "adaptWithAi": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(expanded.status(), StatusCode::OK);
    let exp_json: serde_json::Value = expanded.json().await.unwrap();
    assert!(exp_json["expandedText"].as_str().unwrap().contains("LGTM"));

    // 5. Offline transcription returns clear 503 when whisper-cli/model missing
    let wav_b64 = base64::engine::general_purpose::STANDARD.encode(b"RIFF\x24\x00\x00\x00WAVE");
    let tr_missing = client
        .post(format!("{base}/v1/transcribe"))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .json(&serde_json::json!({
            "audioBase64": wav_b64,
            "audioFormat": "wav"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(tr_missing.status(), StatusCode::SERVICE_UNAVAILABLE);
    let tr_err: serde_json::Value = tr_missing.json().await.unwrap();
    assert!(
        tr_err["error"]
            .as_str()
            .unwrap()
            .to_ascii_lowercase()
            .contains("whisper")
    );

    // 6. Doctor endpoint returns real Tier 0 latency, measured tok/s, manifests, models, privacyProof
    let doc_res = client
        .get(format!("{base}/v1/doctor"))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .send()
        .await
        .unwrap();
    assert_eq!(doc_res.status(), StatusCode::OK);
    let doc_json: serde_json::Value = doc_res.json().await.unwrap();
    assert!(doc_json["tier0LatencyMs"].as_f64().unwrap() >= 0.0);
    assert!(doc_json["measuredTokPerSec"].as_f64().unwrap() > 0.0);
    assert_eq!(doc_json["privacyProof"]["localOnlyVerified"], true);
    assert_eq!(doc_json["privacyProof"]["zeroTelemetry"], true);
    assert!(!doc_json["models"].as_array().unwrap().is_empty());

    // 7. DB RPC endpoints: crutch words, voice import, style stats, weekly insights, simpo export
    let cw_put = client
        .put(format!("{base}/v1/settings/crutch-words"))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .json(&serde_json::json!({ "words": ["just", "actually", "basically"] }))
        .send()
        .await
        .unwrap();
    assert_eq!(cw_put.status(), StatusCode::OK);
    let cw_json: serde_json::Value = cw_put.json().await.unwrap();
    assert_eq!(cw_json["words"].as_array().unwrap().len(), 3);

    let import_res = client
        .post(format!("{base}/v1/voice-examples/import"))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .json(&serde_json::json!({
            "source": "paste",
            "samples": [
                {
                    "surfaceId": "web_github_pr",
                    "text": "Split the cache cleanup into a dedicated pass so retries stay fast."
                },
                {
                    "surfaceId": "web_discord_slack",
                    "text": "Merged the fix and confirmed latency is down on staging."
                }
            ]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(import_res.status(), StatusCode::OK);
    let imp_json: serde_json::Value = import_res.json().await.unwrap();
    assert_eq!(imp_json["importedCount"], 2);

    let insights_res = client
        .get(format!("{base}/v1/analytics/insights?days=7"))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .send()
        .await
        .unwrap();
    assert_eq!(insights_res.status(), StatusCode::OK);
    let ins_json: serde_json::Value = insights_res.json().await.unwrap();
    assert_eq!(ins_json["periodDays"], 7);
    assert_eq!(ins_json["voiceExamplesCount"], 2);

    // 7b. Extended Tier 0 check returns slopMeter, consistency, guards (crutch words / regret shield), and cacheStats
    let ext_t0 = client
        .post(format!("{base}/v1/tier0/check"))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .json(&serde_json::json!({
            "text": "Obviously we just need color and colour in Github and GitHub. See attached.",
            "surfaceId": "web_gmail"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(ext_t0.status(), StatusCode::OK);
    let ext_t0_json: serde_json::Value = ext_t0.json().await.unwrap();
    assert!(ext_t0_json["slopMeter"]["score"].is_number());
    assert!(!ext_t0_json["consistency"].as_array().unwrap().is_empty());
    assert!(!ext_t0_json["guards"].as_array().unwrap().is_empty());
    assert!(ext_t0_json["cacheStats"]["paragraphsTotal"].is_number());

    let simpo_res = client
        .get(format!(
            "{base}/v1/voice-examples/export-simpo?includeAccepted=true"
        ))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .send()
        .await
        .unwrap();
    assert_eq!(simpo_res.status(), StatusCode::OK);
    let simpo_json: serde_json::Value = simpo_res.json().await.unwrap();
    assert!(simpo_json["pairs"].as_array().is_some());

    // 8. End-to-end whisper-cli execution with a local stub script + dummy GGML model + optional rewrite
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let bin_dir = tmp.join("bin");
        let whisper_dir = tmp.join("models").join("whisper");
        std::fs::create_dir_all(&bin_dir).unwrap();
        std::fs::create_dir_all(&whisper_dir).unwrap();
        let fake_whisper = bin_dir.join("whisper-cli");
        std::fs::write(
            &fake_whisper,
            "#!/usr/bin/env bash\necho '[BLANK_AUDIO]'\necho 'We should delve into PR 42 — fix timeout.'\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake_whisper, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(whisper_dir.join("ggml-tiny.en.bin"), b"stub-model").unwrap();

        let tr_ok = client
            .post(format!("{base}/v1/transcribe"))
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .json(&serde_json::json!({
                "audioBase64": wav_b64,
                "audioFormat": "wav",
                "language": "en",
                "surfaceId": "web_github_pr",
                "rewriteTask": "deslop"
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(tr_ok.status(), StatusCode::OK);
        let tr_json: serde_json::Value = tr_ok.json().await.unwrap();
        assert_eq!(
            tr_json["rawTranscript"],
            "We should delve into PR 42 — fix timeout."
        );
        assert!(!tr_json["cleanedText"].as_str().unwrap().contains("delve"));
        assert!(!tr_json["cleanedText"].as_str().unwrap().contains('—'));
        assert_eq!(tr_json["whisperModel"], "ggml-tiny.en.bin");
        // Verify temp audio file was deleted immediately after whisper-cli exited.
        let leftover_wavs: Vec<_> = std::fs::read_dir(tmp.join("tmp"))
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert!(leftover_wavs.is_empty());
    }

    daemon_srv.abort();
    mock_srv.abort();
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn runtime_details_probes_llama_server_flags_when_present() {
    let tmp = std::env::temp_dir().join(format!("lexel-rt-probe-{}", uuid::Uuid::new_v4()));
    let models_dir = tmp.join("models");
    let bin_dir = tmp.join("bin");
    std::fs::create_dir_all(&models_dir).unwrap();
    std::fs::create_dir_all(&bin_dir).unwrap();

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let fake_llama = bin_dir.join("llama-server");
        std::fs::write(
            &fake_llama,
            "#!/usr/bin/env bash\nif [ \"$1\" = \"--version\" ]; then\n  echo 'version: 1.0.0-test (build 12540)'\nelse\n  echo '--spec-type none,ngram-simple,ngram-cache'\n  echo '--spec-ngram-simple-size-n N'\n  echo '--spec-ngram-simple-size-m N'\n  echo '--cache-prompt'\n  echo '--flash-attn'\nfi\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake_llama, std::fs::Permissions::from_mode(0o755)).unwrap();

        let mgr = lexel_daemon::runtime::RuntimeManager::new(tmp.clone(), models_dir);
        let details = mgr.runtime_details().await;
        assert!(details.speculative_lookup_supported);
        assert_eq!(
            details.speculative_lookup_flag.as_deref(),
            Some("--spec-type ngram-simple")
        );
        assert!(details.cache_prompt_supported);
        assert_eq!(
            details.llama_server_version.as_deref(),
            Some("1.0.0-test (build 12540)")
        );
    }

    let _ = std::fs::remove_dir_all(&tmp);
}
