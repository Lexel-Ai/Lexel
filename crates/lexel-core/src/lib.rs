pub mod cache;
pub mod consistency;
pub mod context_scoper;
pub mod guards;
pub mod harper;
pub mod models;
pub mod profile;
pub mod prompt;
pub mod quality;
pub mod redaction;
pub mod repo_config;
pub mod secrets;
pub mod slop;
pub mod slop_meter;
pub mod snippets;
pub mod surfaces;
pub mod tier0;
pub mod verifier;

use thiserror::Error;

pub use cache::{
    ParagraphCacheStats, ParagraphLintCache, ParagraphSpan, fnv1a_64, split_paragraphs,
};
pub use consistency::{ConsistencyIssue, ConsistencyKind, scan_consistency_issues};
pub use context_scoper::{
    DEFAULT_THREAD_CONTEXT_MAX_TOKENS, ScopedContext, estimate_tokens, scope_thread_context,
};
pub use guards::{
    WritingGuardHit, WritingGuardKind, WritingGuardSeverity, is_bluf_surface, scan_bluf_and_walls,
    scan_crutch_words, scan_regret_shield, scan_writing_guards,
};
pub use harper::{
    HarperDiagnostic, HarperEngine, HarperRuleInfo, ReadabilityReport, RulePreset,
    WeirpackValidationSummary, analyze_readability, build_antislop_weirpack,
    build_antislop_weirpack_bytes, build_custom_weirpack_bytes, decode_weirpack_base64,
    detect_language_from_path, encode_weirpack_base64, normalize_typography, preset_rule_overrides,
    structured_lint_config, synonyms_for, to_sentence_case, to_title_case, validate_weirpack_bytes,
};
pub use models::{ModelManifest, ModelSpec, default_model_manifest};
pub use profile::{
    ActivationKey, AiTaskId, Hotkey, LexelProfile, MainModelTier, RuntimeKind, StoredWeirpack,
    StyleGuideRule, TextSnippet, UnifiedSettings, VoiceExample,
};
pub use prompt::{
    ChatMessage, build_completion_messages, build_repair_messages, build_rewrite_messages,
    build_rewrite_messages_with_surfaces, build_snippet_adapt_messages,
    build_ultra_short_take_messages, select_relevant_voice_examples,
};
pub use quality::{
    InvisibleCharHit, StructureIssue, StyleGuideHit, SurfaceGradeTarget, apply_style_guide_fixes,
    scan_invisible_chars, scan_structure_issues, scan_style_guide, strip_invisible_chars,
    surface_grade_target,
};
pub use redaction::{
    RedactedPlaceholder, RedactionPreview, RedactionSession, RestorationResult,
    has_redaction_placeholder, redact_secrets_and_pii,
};
pub use repo_config::{CommitConventions, DocsConfig, REPO_CONFIG_FILENAMES, RepoConfig};
pub use secrets::{SecretMatch, mask_secret_value, scan_secrets};
pub use slop::{SlopHit, SlopScanner, ignored_prose_ranges, parse_custom_slop_entry};
pub use slop_meter::{
    PastedAiAssessment, PastedAiThresholds, SlopMeterBreakdown, SlopMeterContributorKind,
    SlopMeterLabel, SlopMeterOptions, SlopMeterReport, SlopMeterSpan, detect_pasted_ai,
    detect_pasted_ai_with_thresholds, score_slop_meter,
};
pub use snippets::{
    ExpandedSnippet, SnippetEntry, builtin_snippets, expand_snippet_deterministic, merged_snippets,
};
pub use surfaces::{SurfaceCatalog, SurfaceProfile, SurfaceViolation};
pub use tier0::{Tier0CheckOptions, Tier0Engine, Tier0Report, run_tier0_check};
pub use verifier::{
    GateCheckSummary, SafeFixResult, apply_safe_deterministic_fixes, gate_score,
    hard_gate_failures, sanitize_model_output, verify_completion, verify_rewrite,
    verify_rewrite_with_overrides, verify_rewrite_with_surfaces,
};

/// Top-level errors returned by `lexel-core`.
#[derive(Debug, Error)]
pub enum CoreError {
    #[error("failed to parse embedded asset JSON: {0}")]
    EmbeddedJson(#[from] serde_json::Error),
    #[error("invalid regex pattern in verifier: {0}")]
    Regex(#[from] regex::Error),
    #[error("unknown surface id: {0}")]
    UnknownSurface(String),
    #[error("invalid lint config JSON: {0}")]
    InvalidLintConfig(String),
}
