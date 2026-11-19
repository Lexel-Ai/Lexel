use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use lexel_core::{
    HarperEngine, SlopScanner, SurfaceCatalog, UnifiedSettings, apply_safe_deterministic_fixes,
    apply_style_guide_fixes, detect_language_from_path, normalize_typography, scan_invisible_chars,
    scan_secrets, scan_structure_issues, scan_style_guide,
};
use lexel_db::{LexelDb, default_db_path};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tower_lsp_server::jsonrpc::Result as RpcResult;
use tower_lsp_server::lsp_types::{
    CodeAction, CodeActionKind, CodeActionOptions, CodeActionOrCommand, CodeActionParams,
    CodeActionProviderCapability, CodeActionResponse, Diagnostic, DiagnosticSeverity,
    DidChangeTextDocumentParams, DidCloseTextDocumentParams, DidOpenTextDocumentParams,
    DidSaveTextDocumentParams, InitializeParams, InitializeResult, InitializedParams,
    NumberOrString, Position, Range, ServerCapabilities, ServerInfo, TextDocumentSyncCapability,
    TextDocumentSyncKind, TextEdit, Uri, WorkspaceEdit,
};
use tower_lsp_server::{Client, LanguageServer, UriExt};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticFixData {
    suggestions: Vec<String>,
}

#[derive(Debug, Clone)]
struct OpenDocument {
    language_id: String,
    text: String,
}

/// Convert a UTF-8 byte offset in `text` to an LSP UTF-16 `(line, character)` `Position`.
pub fn byte_offset_to_position(text: &str, byte_offset: usize) -> Position {
    let clamped = byte_offset.min(text.len());
    let mut line = 0u32;
    let mut utf16_col = 0u32;
    for (idx, ch) in text.char_indices() {
        if idx >= clamped {
            break;
        }
        if ch == '\n' {
            line += 1;
            utf16_col = 0;
        } else {
            utf16_col += ch.len_utf16() as u32;
        }
    }
    Position::new(line, utf16_col)
}

/// Convert a Unicode scalar `char` offset (used by Harper spans) to an LSP UTF-16 `Position`.
pub fn char_offset_to_position(text: &str, char_offset: usize) -> Position {
    let mut line = 0u32;
    let mut utf16_col = 0u32;
    for (idx, ch) in text.chars().enumerate() {
        if idx >= char_offset {
            break;
        }
        if ch == '\n' {
            line += 1;
            utf16_col = 0;
        } else {
            utf16_col += ch.len_utf16() as u32;
        }
    }
    Position::new(line, utf16_col)
}

/// Resolve effective Harper language ID and Lexel surface ID from LSP language ID and optional path.
pub fn resolve_language_and_surface(
    language_id: &str,
    path: Option<&Path>,
) -> (String, &'static str) {
    let lang = if !language_id.trim().is_empty() && language_id != "plaintext" {
        language_id.to_owned()
    } else if let Some(p) = path {
        detect_language_from_path(p).to_owned()
    } else {
        "plaintext".to_owned()
    };

    let surface = match lang.as_str() {
        "git-commit" | "gitcommit" | "scminput" => "ide_git_commit",
        "markdown" | "mdx" | "asciidoc" | "org" | "tex" | "latex" | "typst" => "docs_markdown",
        "plaintext" => "general",
        _ => "ide_code_comment",
    };

    (lang, surface)
}

/// Compute all deterministic Tier 0 LSP diagnostics for a document without loading any LLM.
pub fn analyze_document(
    text: &str,
    language_id: &str,
    path: Option<&Path>,
    settings: &UnifiedSettings,
) -> Vec<Diagnostic> {
    if text.trim().is_empty() {
        return Vec::new();
    }

    let (lang, surface_id) = resolve_language_and_surface(language_id, path);
    let mut diagnostics = Vec::new();

    if let Ok(mut engine) = HarperEngine::new(
        settings.dialect,
        &settings.lint_config,
        &settings.user_dictionary,
        &settings.ignored_lints,
    ) {
        engine.load_stored_weirpacks(&settings.weirpacks);
        for diag in engine.check_text_with_language(text, &lang) {
            let start = char_offset_to_position(text, diag.start);
            let end = char_offset_to_position(text, diag.end);
            let severity = match diag.lint_kind.as_str() {
                "Spelling" | "Typo" | "Grammar" | "Agreement" => DiagnosticSeverity::WARNING,
                _ => DiagnosticSeverity::INFORMATION,
            };
            let data = if diag.suggestions.is_empty() {
                None
            } else {
                serde_json::to_value(DiagnosticFixData {
                    suggestions: diag.suggestions,
                })
                .ok()
            };
            diagnostics.push(Diagnostic {
                range: Range::new(start, end),
                severity: Some(severity),
                code: Some(NumberOrString::String(diag.rule)),
                source: Some("Lexel/Harper".to_owned()),
                message: diag.message,
                data,
                ..Default::default()
            });
        }
    }

    if let Ok(catalog) = SurfaceCatalog::load_with_custom(&settings.custom_surfaces)
        && let Ok(profile) = catalog.get(surface_id)
    {
        if let Ok(scanner) = SlopScanner::load_embedded() {
            for hit in scanner.scan_with_overrides(
                text,
                profile.allow_em_dashes,
                &settings.custom_slop_terms,
                &settings.disabled_slop_terms,
            ) {
                let start = byte_offset_to_position(text, hit.start);
                let end = byte_offset_to_position(text, hit.end);
                let (code, message) = if hit.is_em_dash {
                    (
                        "em_dash".to_owned(),
                        "Em dash detected; replace with a comma, period, or parentheses."
                            .to_owned(),
                    )
                } else if let Some(ref repl) = hit.suggestion {
                    if repl.is_empty() {
                        (
                            format!("slop:{}", hit.term),
                            format!("AI filler phrase \"{}\". Remove it cleanly.", hit.term),
                        )
                    } else {
                        (
                            format!("slop:{}", hit.term),
                            format!("AI buzzword \"{}\". Prefer \"{repl}\".", hit.term),
                        )
                    }
                } else {
                    (
                        format!("slop:{}", hit.term),
                        format!("AI buzzword \"{}\". Use direct phrasing.", hit.term),
                    )
                };
                let data = hit.suggestion.map(|s| {
                    serde_json::to_value(DiagnosticFixData {
                        suggestions: vec![s],
                    })
                    .unwrap_or_default()
                });
                diagnostics.push(Diagnostic {
                    range: Range::new(start, end),
                    severity: Some(DiagnosticSeverity::WARNING),
                    code: Some(NumberOrString::String(code)),
                    source: Some("Lexel/AntiSlop".to_owned()),
                    message,
                    data,
                    ..Default::default()
                });
            }
        }

        if let Ok(violations) = catalog.validate(text, surface_id) {
            for v in violations {
                let start = byte_offset_to_position(text, v.start);
                let end = byte_offset_to_position(text, v.end);
                diagnostics.push(Diagnostic {
                    range: Range::new(start, end),
                    severity: Some(DiagnosticSeverity::HINT),
                    code: Some(NumberOrString::String(v.kind)),
                    source: Some("Lexel/Surface".to_owned()),
                    message: v.message,
                    ..Default::default()
                });
            }
        }
    }

    for secret in scan_secrets(text) {
        let start = byte_offset_to_position(text, secret.start);
        let end = byte_offset_to_position(text, secret.end);
        diagnostics.push(Diagnostic {
            range: Range::new(start, end),
            severity: Some(DiagnosticSeverity::ERROR),
            code: Some(NumberOrString::String(secret.kind)),
            source: Some("Lexel/SecretsGuard".to_owned()),
            message: format!(
                "Detected {} ({}). Redact before committing or sharing.",
                secret.label, secret.masked_preview
            ),
            data: serde_json::to_value(DiagnosticFixData {
                suggestions: vec!["[REDACTED]".to_owned()],
            })
            .ok(),
            ..Default::default()
        });
    }

    for inv in scan_invisible_chars(text) {
        let start = byte_offset_to_position(text, inv.start);
        let end = byte_offset_to_position(text, inv.end);
        diagnostics.push(Diagnostic {
            range: Range::new(start, end),
            severity: Some(DiagnosticSeverity::WARNING),
            code: Some(NumberOrString::String(inv.codepoint.clone())),
            source: Some("Lexel/InvisibleChars".to_owned()),
            message: format!(
                "Hidden Unicode character {} ({}).",
                inv.label, inv.codepoint
            ),
            data: serde_json::to_value(DiagnosticFixData {
                suggestions: vec![inv.replacement],
            })
            .ok(),
            ..Default::default()
        });
    }

    for issue in scan_structure_issues(text) {
        let start = byte_offset_to_position(text, issue.start);
        let end = byte_offset_to_position(text, issue.end);
        let data = issue.suggestion.map(|s| {
            serde_json::to_value(DiagnosticFixData {
                suggestions: vec![s],
            })
            .unwrap_or_default()
        });
        diagnostics.push(Diagnostic {
            range: Range::new(start, end),
            severity: Some(DiagnosticSeverity::WARNING),
            code: Some(NumberOrString::String(issue.kind)),
            source: Some("Lexel/Structure".to_owned()),
            message: issue.message,
            data,
            ..Default::default()
        });
    }

    for hit in scan_style_guide(text, &settings.style_guide) {
        let start = byte_offset_to_position(text, hit.start);
        let end = byte_offset_to_position(text, hit.end);
        let note = hit
            .note
            .as_deref()
            .map(|n| format!(" ({n})"))
            .unwrap_or_default();
        diagnostics.push(Diagnostic {
            range: Range::new(start, end),
            severity: Some(DiagnosticSeverity::WARNING),
            code: Some(NumberOrString::String(format!("style:{}", hit.term))),
            source: Some("Lexel/StyleGuide".to_owned()),
            message: format!(
                "Team style guide prefers \"{}\" over \"{}\"{note}.",
                hit.preferred, hit.term
            ),
            data: serde_json::to_value(DiagnosticFixData {
                suggestions: vec![hit.preferred],
            })
            .ok(),
            ..Default::default()
        });
    }

    diagnostics
}

/// Apply all safe deterministic Lexel fixes (invisible chars, slop, style guide, typography, single-suggestion Harper fixes).
pub fn apply_full_safe_fixes(
    text: &str,
    language_id: &str,
    path: Option<&Path>,
    settings: &UnifiedSettings,
) -> Option<String> {
    let (lang, surface_id) = resolve_language_and_surface(language_id, path);
    let mut current = text.to_owned();
    let mut total = 0usize;

    if let Ok(det) = apply_safe_deterministic_fixes(
        &current,
        surface_id,
        &settings.custom_slop_terms,
        &settings.disabled_slop_terms,
        &settings.custom_surfaces,
    ) {
        total += det.fixes_applied;
        current = det.text;
    }

    let styled = apply_style_guide_fixes(&current, &settings.style_guide);
    total += styled.fixes_applied;
    current = styled.text;

    let norm = normalize_typography(&current);
    total += norm.fixes_applied;
    current = norm.text;

    if let Ok(mut engine) = HarperEngine::new(
        settings.dialect,
        &settings.lint_config,
        &settings.user_dictionary,
        &settings.ignored_lints,
    ) {
        engine.load_stored_weirpacks(&settings.weirpacks);
        let grammar = engine.apply_safe_harper_fixes(&current, &lang);
        total += grammar.fixes_applied;
        current = grammar.text;
    }

    if total > 0 && current != text {
        Some(current)
    } else {
        None
    }
}

/// Build LSP quick-fix and source-fix-all code actions for a document range.
#[allow(clippy::mutable_key_type)]
pub fn build_code_actions(
    uri: &Uri,
    text: &str,
    diagnostics: &[Diagnostic],
    language_id: &str,
    path: Option<&Path>,
    settings: &UnifiedSettings,
) -> CodeActionResponse {
    let mut actions = Vec::new();

    for diag in diagnostics {
        let Some(ref raw_data) = diag.data else {
            continue;
        };
        let Ok(parsed) = serde_json::from_value::<DiagnosticFixData>(raw_data.clone()) else {
            continue;
        };
        for suggestion in parsed.suggestions {
            let title = if suggestion.is_empty() {
                "Lexel: Remove flagged text".to_owned()
            } else {
                format!("Lexel: Replace with \"{suggestion}\"")
            };
            let mut changes = HashMap::new();
            changes.insert(
                uri.clone(),
                vec![TextEdit {
                    range: diag.range,
                    new_text: suggestion,
                }],
            );
            actions.push(CodeActionOrCommand::CodeAction(CodeAction {
                title,
                kind: Some(CodeActionKind::QUICKFIX),
                diagnostics: Some(vec![diag.clone()]),
                edit: Some(WorkspaceEdit {
                    changes: Some(changes),
                    ..Default::default()
                }),
                is_preferred: Some(true),
                ..Default::default()
            }));
        }
    }

    if let Some(fixed_text) = apply_full_safe_fixes(text, language_id, path, settings) {
        let end_pos = byte_offset_to_position(text, text.len());
        let mut changes = HashMap::new();
        changes.insert(
            uri.clone(),
            vec![TextEdit {
                range: Range::new(Position::new(0, 0), end_pos),
                new_text: fixed_text,
            }],
        );
        actions.push(CodeActionOrCommand::CodeAction(CodeAction {
            title: "Lexel: Fix All Safe Issues (No AI)".to_owned(),
            kind: Some(CodeActionKind::SOURCE_FIX_ALL),
            edit: Some(WorkspaceEdit {
                changes: Some(changes),
                ..Default::default()
            }),
            ..Default::default()
        }));
    }

    actions
}

fn load_active_settings() -> UnifiedSettings {
    let db_path = default_db_path();
    if db_path.is_file()
        && let Ok(db) = LexelDb::open(&db_path)
        && let Ok(profile) = db.active_profile()
    {
        return profile.settings;
    }
    UnifiedSettings::default()
}

/// Stdio LSP backend synced with local `lexel.db` active profile settings.
pub struct LexelLanguageServer {
    client: Client,
    docs: Arc<RwLock<HashMap<Uri, OpenDocument>>>,
}

impl LexelLanguageServer {
    pub fn new(client: Client) -> Self {
        Self {
            client,
            docs: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    async fn publish_for(&self, uri: Uri, doc: OpenDocument) {
        let path_buf = uri.to_file_path().map(|p| p.into_owned());
        let settings = load_active_settings();
        let diagnostics =
            analyze_document(&doc.text, &doc.language_id, path_buf.as_deref(), &settings);
        self.client
            .publish_diagnostics(uri, diagnostics, None)
            .await;
    }
}

impl LanguageServer for LexelLanguageServer {
    async fn initialize(&self, _params: InitializeParams) -> RpcResult<InitializeResult> {
        Ok(InitializeResult {
            capabilities: ServerCapabilities {
                text_document_sync: Some(TextDocumentSyncCapability::Kind(
                    TextDocumentSyncKind::FULL,
                )),
                code_action_provider: Some(CodeActionProviderCapability::Options(
                    CodeActionOptions {
                        code_action_kinds: Some(vec![
                            CodeActionKind::QUICKFIX,
                            CodeActionKind::SOURCE_FIX_ALL,
                        ]),
                        ..Default::default()
                    },
                )),
                ..Default::default()
            },
            server_info: Some(ServerInfo {
                name: "lexel-ls".to_owned(),
                version: Some(env!("CARGO_PKG_VERSION").to_owned()),
            }),
        })
    }

    async fn initialized(&self, _params: InitializedParams) {
        tracing::info!("lexel-ls initialized");
    }

    async fn shutdown(&self) -> RpcResult<()> {
        Ok(())
    }

    async fn did_open(&self, params: DidOpenTextDocumentParams) {
        let uri = params.text_document.uri;
        let doc = OpenDocument {
            language_id: params.text_document.language_id,
            text: params.text_document.text,
        };
        self.docs.write().await.insert(uri.clone(), doc.clone());
        self.publish_for(uri, doc).await;
    }

    async fn did_change(&self, params: DidChangeTextDocumentParams) {
        let uri = params.text_document.uri;
        let Some(change) = params.content_changes.into_iter().last() else {
            return;
        };
        let doc = {
            let mut map = self.docs.write().await;
            let entry = map.entry(uri.clone()).or_insert_with(|| OpenDocument {
                language_id: "plaintext".to_owned(),
                text: String::new(),
            });
            entry.text = change.text;
            entry.clone()
        };
        self.publish_for(uri, doc).await;
    }

    async fn did_save(&self, params: DidSaveTextDocumentParams) {
        let uri = params.text_document.uri;
        let maybe_doc = {
            let mut map = self.docs.write().await;
            if let Some(text) = params.text
                && let Some(doc) = map.get_mut(&uri)
            {
                doc.text = text;
            }
            map.get(&uri).cloned()
        };
        if let Some(doc) = maybe_doc {
            self.publish_for(uri, doc).await;
        }
    }

    async fn did_close(&self, params: DidCloseTextDocumentParams) {
        let uri = params.text_document.uri;
        self.docs.write().await.remove(&uri);
        self.client.publish_diagnostics(uri, Vec::new(), None).await;
    }

    async fn code_action(&self, params: CodeActionParams) -> RpcResult<Option<CodeActionResponse>> {
        let uri = params.text_document.uri;
        let Some(doc) = self.docs.read().await.get(&uri).cloned() else {
            return Ok(None);
        };
        let path_buf = uri.to_file_path().map(|p| p.into_owned());
        let settings = load_active_settings();
        let actions = build_code_actions(
            &uri,
            &doc.text,
            &params.context.diagnostics,
            &doc.language_id,
            path_buf.as_deref(),
            &settings,
        );
        if actions.is_empty() {
            Ok(None)
        } else {
            Ok(Some(actions))
        }
    }
}
