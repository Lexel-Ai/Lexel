use std::fs;
use std::path::Path;
use std::process::Command;
use std::str::FromStr;

use lexel_core::{StyleGuideRule, UnifiedSettings};
use lexel_ls::{
    analyze_document, apply_full_safe_fixes, build_code_actions, read_git_diff_context,
};
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

#[test]
fn lsp_honors_repo_lexel_toml_and_reads_git_diff_context() {
    let dir = std::env::temp_dir().join(format!("lexel-lsp-repo-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("docs")).expect("mkdir");
    fs::write(
        dir.join(".lexel.toml"),
        r#"
dictionary = ["Zorblaxian"]
banned_slop_terms = ["hypergrowth => growth"]

[commit]
allowed_types = ["feat", "fix"]
require_conventional = true
max_subject_chars = 50
"#,
    )
    .expect("write .lexel.toml");

    let doc_path = dir.join("docs").join("guide.md");
    fs::write(&doc_path, "Zorblaxian avoids hypergrowth hype.\n").expect("write guide");

    let settings = UnifiedSettings::default();
    let diags = analyze_document(
        "Zorblaxian avoids hypergrowth hype.\n",
        "markdown",
        Some(&doc_path),
        &settings,
    );
    assert!(
        diags
            .iter()
            .any(|d| d.source.as_deref() == Some("Lexel/AntiSlop")),
        "expected custom repo slop term diagnostic: {diags:?}"
    );
    assert!(
        !diags.iter().any(|d| d.message.contains("Zorblaxian")),
        "project dictionary word should not be flagged as misspelled: {diags:?}"
    );

    let commit_path = dir.join("COMMIT_EDITMSG");
    let commit_diags = analyze_document(
        "chore: this commit subject violates both allowed_types and max length.",
        "git-commit",
        Some(&commit_path),
        &settings,
    );
    assert!(
        commit_diags
            .iter()
            .any(|d| d.source.as_deref() == Some("Lexel/RepoConfig")),
        "expected Lexel/RepoConfig commit violation: {commit_diags:?}"
    );

    // Initialize a temporary git repo to verify staged and branch diff context extraction
    let git_ok = Command::new("git")
        .args(["init", "-b", "main"])
        .current_dir(&dir)
        .status()
        .is_ok_and(|s| s.success());
    if git_ok {
        let _ = Command::new("git")
            .args(["config", "user.email", "test@lexel.local"])
            .current_dir(&dir)
            .status();
        let _ = Command::new("git")
            .args(["config", "user.name", "Lexel Test"])
            .current_dir(&dir)
            .status();
        let _ = Command::new("git")
            .args(["add", ".lexel.toml", "docs/guide.md"])
            .current_dir(&dir)
            .status();
        let staged_ctx =
            read_git_diff_context(Some(&commit_path), "ide_git_commit", Some("auto"), None)
                .expect("staged diff stat");
        assert!(staged_ctx.contains("docs/guide.md"), "got: {staged_ctx}");

        let _ = Command::new("git")
            .args(["commit", "-m", "feat: initial docs"])
            .current_dir(&dir)
            .status();
        let _ = Command::new("git")
            .args(["checkout", "-b", "feature/pr-diff"])
            .current_dir(&dir)
            .status();
        fs::write(dir.join("docs/guide.md"), "Updated guide for branch PR.\n").expect("update");
        let _ = Command::new("git")
            .args(["commit", "-am", "docs: update guide"])
            .current_dir(&dir)
            .status();

        let pr_path = dir.join("PULL_REQUEST_TEMPLATE.md");
        let pr_ctx = read_git_diff_context(
            Some(&pr_path),
            "web_github_pr",
            Some("branch"),
            Some("main"),
        )
        .expect("branch diff stat");
        assert!(pr_ctx.contains("docs/guide.md"), "got: {pr_ctx}");
        assert!(pr_ctx.contains("docs: update guide"), "got: {pr_ctx}");
    }

    let _ = fs::remove_dir_all(&dir);
}
