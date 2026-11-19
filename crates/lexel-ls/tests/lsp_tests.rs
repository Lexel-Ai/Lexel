use std::path::Path;
use std::str::FromStr;

use lexel_core::{StyleGuideRule, UnifiedSettings};
use lexel_ls::{analyze_document, apply_full_safe_fixes, build_code_actions};
use tower_lsp_server::lsp_types::{CodeActionOrCommand, DiagnosticSeverity, Uri};

#[test]
fn lsp_analyzes_markdown_slop_secrets_invisible_chars_and_style_guide() {
    let mut settings = UnifiedSettings::default();
    settings.style_guide.push(StyleGuideRule {
        term: "postgres".to_owned(),
        preferred: "PostgreSQL".to_owned(),
        case_sensitive: false,
        note: Some("Use official name".to_owned()),
    });

    let doc = "We delve into postgres\u{200B} with sk_live_abcdefghijklmnop1234567890.\n";
    let diags = analyze_document(doc, "markdown", Some(Path::new("README.md")), &settings);

    assert!(
        diags
            .iter()
            .any(|d| d.source.as_deref() == Some("Lexel/AntiSlop")),
        "expected anti-slop diagnostic: {diags:?}"
    );
    assert!(
        diags
            .iter()
            .any(|d| d.source.as_deref() == Some("Lexel/InvisibleChars")),
        "expected invisible char diagnostic: {diags:?}"
    );
    assert!(
        diags
            .iter()
            .any(|d| d.source.as_deref() == Some("Lexel/StyleGuide")),
        "expected style guide diagnostic: {diags:?}"
    );
    assert!(
        diags.iter().any(|d| {
            d.source.as_deref() == Some("Lexel/SecretsGuard")
                && d.severity == Some(DiagnosticSeverity::ERROR)
        }),
        "expected error-level secret diagnostic: {diags:?}"
    );

    let uri = Uri::from_str("file:///tmp/README.md").expect("valid uri");
    let actions = build_code_actions(
        &uri,
        doc,
        &diags,
        "markdown",
        Some(Path::new("README.md")),
        &settings,
    );
    assert!(
        actions.iter().any(|a| matches!(
            a,
            CodeActionOrCommand::CodeAction(ca) if ca.title.contains("PostgreSQL")
        )),
        "expected style guide quick fix action"
    );
    assert!(
        actions.iter().any(|a| matches!(
            a,
            CodeActionOrCommand::CodeAction(ca) if ca.title.contains("Fix All Safe")
        )),
        "expected Fix All Safe source action"
    );
}

#[test]
fn lsp_safe_fixes_clean_commit_and_markdown_prose() {
    let settings = UnifiedSettings::default();
    let fixed = apply_full_safe_fixes(
        "We should delve into an typo — fast\u{200B}.",
        "markdown",
        Some(Path::new("NOTE.md")),
        &settings,
    )
    .expect("safe fixes applied");
    assert!(fixed.contains("explore a typo"), "got: {fixed}");
    assert!(!fixed.contains('—'));
    assert!(!fixed.contains('\u{200B}'));
}
