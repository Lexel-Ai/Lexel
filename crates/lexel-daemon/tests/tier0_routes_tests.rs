use std::sync::Arc;

use axum::http::StatusCode;
use lexel_daemon::auth::ensure_token;
use lexel_daemon::http::build_router;
use lexel_daemon::service::DaemonService;
use tokio::net::TcpListener;

#[tokio::test]
async fn zero_ai_tier0_routes_and_presets_work_end_to_end() {
    let tmp = std::env::temp_dir().join(format!("lexel-daemon-tier0-{}", uuid::Uuid::new_v4()));
    let models_dir = tmp.join("models");
    let token_path = tmp.join("daemon.token");
    std::fs::create_dir_all(&models_dir).expect("models dir");

    let token = ensure_token(&token_path).expect("token");
    let service = Arc::new(
        DaemonService::open(tmp.clone(), tmp.join("lexel.db"), models_dir, token_path, 0)
            .expect("daemon service"),
    );

    let router = build_router(Arc::clone(&service), token.clone());
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind listener");
    let addr = listener.local_addr().expect("local addr");
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    let client = reqwest::Client::new();
    let base = format!("http://{addr}");

    let readability = client
        .post(format!("{base}/v1/tier0/readability"))
        .bearer_auth(&token)
        .json(&serde_json::json!({
            "text": "Short tests verify deterministic rules quickly. Clear prose helps readers."
        }))
        .send()
        .await
        .expect("readability request");
    assert_eq!(readability.status(), StatusCode::OK);
    let r_json: serde_json::Value = readability.json().await.expect("readability json");
    assert_eq!(r_json["words"], 10);
    assert_eq!(r_json["sentences"], 2);

    let sentence = client
        .post(format!("{base}/v1/tier0/sentence-case"))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "text": "THIS API WORKS. SECOND LINE!" }))
        .send()
        .await
        .expect("sentence-case request");
    assert_eq!(sentence.status(), StatusCode::OK);
    let s_json: serde_json::Value = sentence.json().await.expect("sentence json");
    assert_eq!(s_json["text"], "This api works. Second line!");

    let normalized = client
        .post(format!("{base}/v1/tier0/normalize-typography"))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "text": "“Curly”  quotes…  " }))
        .send()
        .await
        .expect("normalize request");
    assert_eq!(normalized.status(), StatusCode::OK);
    let n_json: serde_json::Value = normalized.json().await.expect("normalize json");
    assert_eq!(n_json["text"], "\"Curly\" quotes...");

    let fix_all = client
        .post(format!("{base}/v1/tier0/fix-all-safe"))
        .bearer_auth(&token)
        .json(&serde_json::json!({
            "text": "We should delve into an typo — fast.",
            "surfaceId": "general",
            "language": "plaintext"
        }))
        .send()
        .await
        .expect("fix-all-safe request");
    assert_eq!(fix_all.status(), StatusCode::OK);
    let f_json: serde_json::Value = fix_all.json().await.expect("fix-all json");
    let fixed_text = f_json["text"].as_str().expect("fixed text");
    assert!(fixed_text.contains("explore a typo"), "got: {fixed_text}");
    assert!(!fixed_text.contains('—'));

    let preset_res = client
        .post(format!("{base}/v1/harper/apply-preset"))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "preset": "strict_technical" }))
        .send()
        .await
        .expect("apply preset");
    assert_eq!(preset_res.status(), StatusCode::OK);
    let p_json: serde_json::Value = preset_res.json().await.expect("preset json");
    assert_eq!(p_json["settings"]["lintConfig"]["OxfordComma"], true);
    assert_eq!(p_json["settings"]["lintConfig"]["NoOxfordComma"], false);

    let rpc_res = service
        .dispatch_rpc(
            "readability",
            serde_json::json!({ "text": "One crisp sentence." }),
        )
        .await
        .expect("rpc readability");
    assert_eq!(rpc_res["words"], 3);

    let rpc_preset = service
        .dispatch_rpc(
            "applyRulePreset",
            serde_json::json!({ "preset": "curated" }),
        )
        .await
        .expect("rpc curated preset");
    assert_eq!(rpc_preset["settings"]["lintConfig"], serde_json::json!({}));

    let weir_res = client
        .post(format!("{base}/v1/harper/weirpack/build"))
        .bearer_auth(&token)
        .json(&serde_json::json!({
            "ruleName": "NoBuzzSynergy",
            "expr": "synergy",
            "replacement": "coordination",
            "message": "Prefer coordination.",
            "testBad": "Team synergy wins.",
            "testGood": "Team coordination wins."
        }))
        .send()
        .await
        .expect("build weirpack");
    assert_eq!(weir_res.status(), StatusCode::OK);
    let weir_json: serde_json::Value = weir_res.json().await.expect("weir json");
    assert_eq!(weir_json["weirpack"]["name"], "NoBuzzSynergy.weirpack");
    assert_eq!(
        weir_json["profile"]["settings"]["weirpacks"]
            .as_array()
            .map(|a| a.len()),
        Some(1)
    );

    let tier0_with_weir = client
        .post(format!("{base}/v1/tier0/check"))
        .bearer_auth(&token)
        .json(&serde_json::json!({
            "text": "Our synergy helps.",
            "surfaceId": "general"
        }))
        .send()
        .await
        .expect("tier0 check with synced weirpack");
    assert_eq!(tier0_with_weir.status(), StatusCode::OK);
    let check_json: serde_json::Value = tier0_with_weir.json().await.expect("check json");
    let harper_hits = check_json["harper"].as_array().expect("harper array");
    assert!(
        harper_hits.iter().any(|h| h["rule"] == "NoBuzzSynergy"),
        "expected synced weirpack rule to fire: {harper_hits:?}"
    );

    server.abort();
    let _ = std::fs::remove_dir_all(&tmp);
}
