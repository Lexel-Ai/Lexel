pub mod harper;
pub mod models;
pub mod profile;
pub mod prompt;
pub mod secrets;
pub mod slop;
pub mod surfaces;
pub mod verifier;

use thiserror::Error;

pub use harper::{
    HarperDiagnostic, HarperEngine, HarperRuleInfo, WeirpackValidationSummary,
    structured_lint_config, synonyms_for, to_title_case, validate_weirpack_bytes,
};
pub use models::{ModelManifest, ModelSpec, default_model_manifest};
pub use profile::{
    ActivationKey, AiTaskId, Hotkey, LexelProfile, MainModelTier, RuntimeKind, UnifiedSettings,
    VoiceExample,
};
pub use prompt::{ChatMessage, build_rewrite_messages, select_relevant_voice_examples};
pub use secrets::{SecretMatch, scan_secrets};
pub use slop::{SlopHit, SlopScanner};
pub use surfaces::{SurfaceCatalog, SurfaceProfile, SurfaceViolation};
pub use verifier::{
    GateCheckSummary, SafeFixResult, apply_safe_deterministic_fixes, sanitize_model_output,
    verify_rewrite,
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
