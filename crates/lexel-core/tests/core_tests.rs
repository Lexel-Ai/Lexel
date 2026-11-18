use std::collections::BTreeMap;

use lexel_core::{
    AiTaskId, HarperEngine, MainModelTier, SlopScanner, SurfaceCatalog, SurfaceProfile,
    UnifiedSettings, VoiceExample, apply_safe_deterministic_fixes, build_rewrite_messages,
    default_model_manifest, sanitize_model_output, scan_secrets, structured_lint_config,
    synonyms_for, to_title_case, validate_weirpack_bytes, verify_rewrite,
};

#[test]
fn manifest_contains_both_required_models() {
    let manifest = default_model_manifest().expect("embedded manifest should parse");
    assert_eq!(manifest.default_main_model, "lexel-1.5b");
    assert!(manifest.find("0.5b").is_some());
    assert!(manifest.find("1.5b").is_some());
    assert_eq!(
        manifest.find("lexel-0.5b").unwrap().ollama_tag,
        "qwen2.5:0.5b"
    );
    assert_eq!(
        manifest.find("lexel-1.5b").unwrap().ollama_tag,
        "qwen2.5:1.5b"
    );
}

#[test]
fn slop_scanner_flags_terms_and_em_dashes() {
    let scanner = SlopScanner::load_embedded().expect("slop scanner should load");
    let hits = scanner.scan("We should delve into this seamless system — fast.", false);
    assert!(hits.iter().any(|h| h.term.eq_ignore_ascii_case("delve")));
    assert!(hits.iter().any(|h| h.term.eq_ignore_ascii_case("seamless")));
    assert!(hits.iter().any(|h| h.is_em_dash));
}

#[test]
fn harper_engine_checks_text_and_lists_rules() {
    let mut engine =
        HarperEngine::new(0, &BTreeMap::new(), &["Weirpack".to_owned()], "").expect("engine init");
    let catalog = engine.rule_catalog();
    assert!(catalog.len() > 100);

    let clean = engine.check_text("Weirpack works well.");
    assert!(clean.is_empty(), "expected custom word to pass: {clean:?}");

    let typo = engine.check_text("This is an test.");
    assert!(!typo.is_empty());
}

#[test]
fn tier2_verifier_checks_slop_numbers_tokens_and_surface() {
    let good = verify_rewrite(
        "Cut `lexel-core` latency from 42ms to 18ms on #42.",
        "Reduced `lexel-core` latency from 42ms to 18ms on #42.",
        "web_github_pr",
        0,
        &["lexel-core".to_owned()],
    )
    .expect("verifier");
    assert!(good.zero_slop);
    assert!(good.numbers_preserved);
    assert!(good.tokens_preserved);
    assert!(good.surface_compliant);

    let bad = verify_rewrite(
        "Latency dropped to 18ms on #42.",
        "Latency seamlessly dropped to 12ms — delve in!",
        "web_reddit",
        0,
        &[],
    )
    .expect("verifier");
    assert!(!bad.zero_slop);
    assert!(!bad.numbers_preserved);
}

#[test]
fn sanitize_and_prompt_builder_work() {
    let cleaned = sanitize_model_output("<think>ok</think>\n```\nDirect reply.\n```");
    assert_eq!(cleaned, "Direct reply.");

    let settings = UnifiedSettings {
        main_model_tier: MainModelTier::Lexel05B,
        ..UnifiedSettings::default()
    };
    assert_eq!(settings.effective_model_name(), "qwen2.5:0.5b");

    let catalog = SurfaceCatalog::load_embedded().unwrap();
    assert!(
        catalog
            .validate("Check out our https://example.com #rust", "web_reddit")
            .unwrap()
            .len()
            >= 3
    );

    let examples = vec![VoiceExample {
        id: "1".to_owned(),
        profile_id: "default".to_owned(),
        surface_id: "web_reddit".to_owned(),
        subcontext: Some("r/rust".to_owned()),
        original: "old".to_owned(),
        rewritten: "Benchmarks look solid.".to_owned(),
        action: "accepted".to_owned(),
        created_at: 1,
    }];
    let msgs = build_rewrite_messages(
        "Benchmarks look good.",
        AiTaskId::RewriteSurface,
        "web_reddit",
        Some("r/rust"),
        None,
        &examples,
    )
    .unwrap();
    assert_eq!(msgs.len(), 2);
    assert!(msgs[0].content.contains("Benchmarks look solid."));
}

#[test]
fn secrets_scanner_detects_keys_jwts_and_luhn_cards_with_masking() {
    let sample = concat!(
        "key=sk-proj-abc1234567890abcdef123456 ",
        "gh=ghp_1234567890abcdef1234567890abcdef1234 ",
        "aws=AKIAIOSFODNN7EXAMPLE ",
        "jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk ",
        "pem=-----BEGIN RSA PRIVATE KEY----- ",
        "ssn=123-45-6789 ",
        "card=4111 1111 1111 1111 ",
        "non_luhn=4111 1111 1111 1112"
    );
    let hits = scan_secrets(sample);
    let kinds: Vec<&str> = hits.iter().map(|h| h.kind.as_str()).collect();
    assert!(kinds.contains(&"api_key"));
    assert!(kinds.contains(&"github_token"));
    assert!(kinds.contains(&"aws_access_key"));
    assert!(kinds.contains(&"jwt"));
    assert!(kinds.contains(&"private_key"));
    assert!(kinds.contains(&"ssn"));
    assert_eq!(
        hits.iter().filter(|h| h.kind == "payment_card").count(),
        1,
        "only Luhn-valid card must match"
    );
    for h in &hits {
        assert!(!h.masked_preview.contains("abc1234567890abcdef"));
        assert!(!h.masked_preview.contains("4111 1111 1111"));
    }

    let gates = verify_rewrite(
        "Share key sk-proj-abc1234567890abcdef123456",
        "Share key sk-proj-abc1234567890abcdef123456",
        "general",
        0,
        &[],
    )
    .unwrap();
    assert!(!gates.secrets_free);
}

#[test]
fn harper_indian_dialect_title_case_synonyms_structured_and_weirpack() {
    let mut engine = HarperEngine::new(4, &BTreeMap::new(), &[], "").expect("Indian dialect init");
    let lints = engine.check_text_with_language("This is an test.", "markdown");
    assert!(!lints.is_empty());

    let titled = to_title_case("building fast local tools in rust");
    assert_eq!(titled, "Building Fast Local Tools in Rust");

    let syns = synonyms_for("fast");
    assert!(!syns.is_empty());

    let structured = structured_lint_config();
    assert!(!structured.settings.is_empty());

    let mut manifest = harper_core::weirpack::WeirpackManifest::new();
    manifest.set_author("Lexel");
    manifest.set_version("0.1.0");
    manifest.set_description("Demo pack");
    manifest.set_license("MIT");
    let mut pack = harper_core::weirpack::Weirpack::new(manifest);
    pack.add_rule(
        "NoReally",
        "expr main really\nlet message \"Use a more concrete word.\"\nlet description \"Replaces filler.\"\nlet kind \"Style\"\nlet becomes \"actually\"\ntest \"I really agree.\" \"I actually agree.\"",
    );
    let bytes = pack.to_bytes().expect("weirpack bytes");
    let summary = validate_weirpack_bytes(&bytes).expect("weirpack validation");
    assert_eq!(summary.rule_count, 1);
}

#[test]
fn custom_slop_surfaces_safe_fixes_and_settings_backcompat() {
    let scanner = SlopScanner::load_embedded().unwrap();
    let custom = vec!["circle back".to_owned()];
    let disabled = vec!["seamless".to_owned()];
    let hits = scanner.scan_with_overrides(
        "We should circle back on this seamless rollout.",
        false,
        &custom,
        &disabled,
    );
    assert!(
        hits.iter()
            .any(|h| h.term.eq_ignore_ascii_case("circle back"))
    );
    assert!(!hits.iter().any(|h| h.term.eq_ignore_ascii_case("seamless")));

    let fixed = apply_safe_deterministic_fixes(
        "We must delve into this — utilize 🚀 #spam",
        "web_reddit",
        &[],
        &[],
        &[],
    )
    .unwrap();
    assert!(!fixed.text.contains('—'));
    assert!(!fixed.text.to_lowercase().contains("delve into"));
    assert!(!fixed.text.to_lowercase().contains("utilize"));
    assert!(!fixed.text.contains('#'));
    assert!(fixed.fixes_applied >= 4);

    let legacy_json = serde_json::json!({
        "theme": "dark",
        "aiEnabled": true,
        "mainModelTier": "lexel-1.5b",
        "customModel": "qwen2.5:1.5b",
        "runtime": "auto",
        "ollamaEndpoint": "http://127.0.0.1:11434",
        "openaiCompatEndpoint": "http://127.0.0.1:8080",
        "temperature": 0.3,
        "maxTokens": 280,
        "idleUnloadSecs": 180,
        "keepWarm": false,
        "saveVoiceMemory": true,
        "dialect": 0,
        "isolateEnglish": false,
        "openSuggestionsOnHover": true,
        "activationKey": "off",
        "lintDelayMs": 0,
        "lintConfig": {},
        "userDictionary": [],
        "ignoredLints": "",
        "privacyBlocklist": [],
        "domainStatuses": {},
        "surfaceOverrides": {}
    });
    let parsed: UnifiedSettings = serde_json::from_value(legacy_json).expect("legacy parse");
    assert_eq!(parsed.language_mode, "plaintext");
    assert!(parsed.custom_slop_terms.is_empty());

    let custom_surface = SurfaceProfile {
        id: "custom_notes".to_owned(),
        label: "Team Notes".to_owned(),
        host_patterns: vec![],
        path_regex: None,
        register: "concise".to_owned(),
        min_chars: 1,
        max_chars: 200,
        allow_links: true,
        allow_emojis: false,
        allow_hashtags: false,
        allow_em_dashes: false,
        banned_openers: vec![],
        prompt_directive: String::new(),
        quick_actions: vec![],
    };
    let catalog = SurfaceCatalog::load_with_custom(&[custom_surface]).unwrap();
    assert_eq!(catalog.get("custom_notes").unwrap().label, "Team Notes");
}
