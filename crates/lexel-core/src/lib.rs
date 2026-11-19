pub mod harper;
pub mod models;
pub mod profile;
pub mod prompt;
pub mod quality;
pub mod secrets;
pub mod slop;
pub mod surfaces;
pub mod verifier;

use thiserror::Error;

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
    ChatMessage, build_rewrite_messages, build_rewrite_messages_with_surfaces,
    select_relevant_voice_examples,
};
pub use quality::{
    InvisibleCharHit, StructureIssue, StyleGuideHit, SurfaceGradeTarget, apply_style_guide_fixes,
    scan_invisible_chars, scan_structure_issues, scan_style_guide, strip_invisible_chars,
    surface_grade_target,
};
pub use secrets::{SecretMatch, mask_secret_value, scan_secrets};
pub use slop::{SlopHit, SlopScanner, ignored_prose_ranges, parse_custom_slop_entry};
pub use surfaces::{SurfaceCatalog, SurfaceProfile, SurfaceViolation};
pub use verifier::{
    GateCheckSummary, SafeFixResult, apply_safe_deterministic_fixes, sanitize_model_output,
    verify_rewrite, verify_rewrite_with_overrides, verify_rewrite_with_surfaces,
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
