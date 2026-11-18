use std::collections::BTreeMap;
use std::path::Path;

use lexel_core::{
    AiTaskId, HarperEngine, RulePreset, SlopScanner, SurfaceCatalog, analyze_readability,
    apply_safe_deterministic_fixes, build_antislop_weirpack_bytes,
    build_rewrite_messages_with_surfaces, detect_language_from_path, normalize_typography,
    preset_rule_overrides, scan_secrets, to_sentence_case, validate_weirpack_bytes,
    verify_rewrite_with_surfaces,
};

#[test]
fn detects_new_secret_kinds_without_overlapping() {
    let sample = [
        "STRIPE=sk_live_abcdefghijklmnop1234567890",
        "hf=hf_abcdefghijklmnopqrstuvwxyz123456",
        "npm=npm_abcdefghijklmnopqrstuvwxyz123456",
        "hook=https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz012345",
        "OPENAI_API_KEY=sk-proj-secretvalue1234567890",
        "DB_PASSWORD=supersecretpassword123",
    ]
    .join("\n");

    let hits = scan_secrets(&sample);
    let kinds: Vec<&str> = hits.iter().map(|h| h.kind.as_str()).collect();
    assert!(kinds.contains(&"stripe_key"), "kinds: {kinds:?}");
    assert!(kinds.contains(&"huggingface_token"), "kinds: {kinds:?}");
    assert!(kinds.contains(&"npm_token"), "kinds: {kinds:?}");
    assert!(kinds.contains(&"discord_webhook"), "kinds: {kinds:?}");
    assert!(kinds.contains(&"env_secret"), "kinds: {kinds:?}");
}

#[test]
fn markdown_code_blocks_and_quotes_are_ignored_in_slop_and_fixes() {
    let text = concat!(
        "We should delve into latency and circle back tomorrow.\n\n",
        "`delve()` inside inline code stays intact.\n\n",
        "> delve into quoted text stays untouched\n\n",
        "```rust\nlet utilize = 1;\n// delve into\n```\n"
    );
    let scanner = SlopScanner::load_embedded().expect("slop scanner");
    let hits = scanner.scan(text, false);
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].term.to_ascii_lowercase(), "delve");
    assert!(hits[0].suggestion.is_some());

    let fixed = apply_safe_deterministic_fixes(
        text,
        "general",
        &["circle back => follow up".to_owned()],
        &[],
        &[],
    )
    .expect("safe fixes");
    assert!(
        fixed
            .text
            .contains("We should explore latency and follow up tomorrow.")
    );
    assert!(
        fixed
            .text
            .contains("`delve()` inside inline code stays intact.")
    );
    assert!(
        fixed
            .text
            .contains("> delve into quoted text stays untouched")
    );
    assert!(fixed.text.contains("let utilize = 1;"));
}

#[test]
fn git_commit_surface_and_excess_punctuation_rules_work() {
    let catalog = SurfaceCatalog::load_embedded().expect("surface catalog");
    let bad_commit = "Added a huge refactor with lots of details across many files that definitely exceeds seventy two chars.\n";
    let violations = catalog
        .validate(bad_commit, "ide_git_commit")
        .expect("validate commit");
    let kinds: Vec<&str> = violations.iter().map(|v| v.kind.as_str()).collect();
    assert!(kinds.contains(&"commit_subject_length"), "kinds: {kinds:?}");
    assert!(kinds.contains(&"commit_subject_period"), "kinds: {kinds:?}");
    assert!(kinds.contains(&"commit_mood"), "kinds: {kinds:?}");

    let loud_email = "Please check this immediately!!! Thanks.";
    let email_violations = catalog
        .validate(loud_email, "web_email")
        .expect("validate email");
    assert!(
        email_violations
            .iter()
            .any(|v| v.kind == "excess_punctuation"),
        "violations: {email_violations:?}"
    );
}

#[test]
fn parses_code_comments_markup_formats_and_detects_extensions() {
    assert_eq!(detect_language_from_path(Path::new("src/lib.rs")), "rust");
    assert_eq!(
        detect_language_from_path(Path::new("COMMIT_EDITMSG")),
        "git-commit"
    );
    assert_eq!(detect_language_from_path(Path::new("paper.tex")), "tex");
    assert_eq!(
        detect_language_from_path(Path::new("manual.adoc")),
        "asciidoc"
    );
    assert_eq!(detect_language_from_path(Path::new("notes.typ")), "typst");
    assert_eq!(detect_language_from_path(Path::new("page.html")), "html");
    assert_eq!(detect_language_from_path(Path::new("script.py")), "python");

    let mut engine = HarperEngine::new(0, &BTreeMap::new(), &[], "").expect("engine init");

    let rust_diags = engine.check_text_with_language(
        "// This is an typo inside a comment.\nfn foo_bar() {}\n",
        "rust",
    );
    assert!(
        !rust_diags.is_empty(),
        "expected comment grammar/article lint in Rust"
    );

    let html_diags = engine.check_text_with_language("<p>This is an typo test.</p>", "html");
    assert!(
        !html_diags.is_empty(),
        "expected lint inside HTML paragraph"
    );

    let tex_diags =
        engine.check_text_with_language("\\section{Intro}\nThis is an typo test.", "tex");
    assert!(!tex_diags.is_empty(), "expected lint inside TeX document");

    let commit_diags = engine.check_text_with_language("Fix an typo in parser.", "git-commit");
    assert!(
        !commit_diags.is_empty(),
        "expected lint inside git-commit message"
    );

    let safe = engine.apply_safe_harper_fixes("This is an typo in the code.", "plaintext");
    assert!(safe.fixes_applied >= 1);
    assert!(safe.text.contains("a typo"), "got: {}", safe.text);
}

#[test]
fn readability_sentence_case_typography_presets_and_weirpack_bytes_work() {
    let presets = preset_rule_overrides(RulePreset::StrictTechnical);
    assert_eq!(presets.get("OxfordComma"), Some(&Some(true)));
    assert_eq!(presets.get("NoOxfordComma"), Some(&Some(false)));
    assert_eq!(
        preset_rule_overrides(RulePreset::CasualChat).get("SentenceCapitalization"),
        Some(&Some(false))
    );

    let sentence = to_sentence_case("this API uses `delve()` and SQL. second sentence here!");
    assert_eq!(
        sentence,
        "This API uses `delve()` and SQL. Second sentence here!"
    );
    assert_eq!(
        to_sentence_case("HELLO WORLD. SECOND SENTENCE!"),
        "Hello world. Second sentence!"
    );

    let normalized = normalize_typography(
        "“Smart quotes” and ellipses…  with extra   spaces.   \n\n```python\n    keep_indent  = True\n```",
    );
    assert!(normalized.text.contains("\"Smart quotes\""));
    assert!(normalized.text.contains("ellipses..."));
    assert!(normalized.text.contains("    keep_indent  = True"));

    let report = analyze_readability(
        "Short sentences read quickly and clearly. Testing tools verify code before release.",
    );
    assert_eq!(report.words, 12);
    assert_eq!(report.sentences, 2);
    assert!(report.flesch_reading_ease > 40.0);

    let pack_bytes = build_antislop_weirpack_bytes().expect("build antislop weirpack");
    let summary = validate_weirpack_bytes(&pack_bytes).expect("validate antislop weirpack");
    assert_eq!(summary.rule_count, 10);
    assert!(
        summary.failures.is_empty(),
        "failures: {:?}",
        summary.failures
    );

    let mut engine = HarperEngine::new(0, &BTreeMap::new(), &[], "").expect("engine");
    engine
        .add_weirpack_bytes(&pack_bytes)
        .expect("merge antislop weirpack");
    let diags = engine.check_text("We should delve into this paradigm.");
    assert!(
        diags.iter().any(|d| d.rule == "LexelDelveInto"),
        "expected LexelDelveInto diagnostic, got: {diags:?}"
    );
}

#[test]
fn custom_surface_prompt_and_rule_overrides_propagate_through_prompt_and_verifier() {
    let catalog = SurfaceCatalog::load_embedded().expect("surface catalog");
    let mut custom_reddit = catalog.get("web_reddit").expect("web_reddit").clone();
    custom_reddit.prompt_directive = "Speak like a concise Linux kernel maintainer.".to_owned();
    custom_reddit.allow_links = true;
    custom_reddit.max_chars = 1200;

    let messages = build_rewrite_messages_with_surfaces(
        "My Rust script is slow.",
        AiTaskId::RewriteSurface,
        "web_reddit",
        Some("r/rust"),
        None,
        &[],
        &[custom_reddit.clone()],
    )
    .expect("build custom messages");
    assert!(
        messages[0]
            .content
            .contains("concise Linux kernel maintainer")
    );
    assert!(messages[0].content.contains("Max characters: 1200"));

    let gates = verify_rewrite_with_surfaces(
        "Check https://example.com for details.",
        "Check https://example.com for benchmark details.",
        "web_reddit",
        0,
        &[],
        &[custom_reddit],
    )
    .expect("verify with custom surface");
    assert!(
        gates.surface_compliant,
        "expected overridden allow_links=true to pass: {:?}",
        gates.warnings
    );
}
