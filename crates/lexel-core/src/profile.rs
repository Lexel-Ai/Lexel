use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::surfaces::SurfaceProfile;

/// Canonical local AI model tier selection.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum MainModelTier {
    #[serde(rename = "lexel-0.5b")]
    Lexel05B,
    #[default]
    #[serde(rename = "lexel-1.5b")]
    Lexel15B,
    Custom,
}

impl MainModelTier {
    /// Map canonical tier to the default Ollama tag used when running through Ollama.
    pub fn default_ollama_tag(&self) -> Option<&'static str> {
        match self {
            Self::Lexel05B => Some("qwen2.5:0.5b"),
            Self::Lexel15B => Some("qwen2.5:1.5b"),
            Self::Custom => None,
        }
    }

    /// Map canonical tier to its manifest model ID.
    pub fn manifest_id(&self) -> Option<&'static str> {
        match self {
            Self::Lexel05B => Some("lexel-0.5b"),
            Self::Lexel15B => Some("lexel-1.5b"),
            Self::Custom => None,
        }
    }
}

/// Local inference backend strategy.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeKind {
    #[default]
    Auto,
    LlamaServer,
    Ollama,
    #[serde(rename = "openai_compat")]
    OpenAiCompat,
}

/// Global keyboard shortcut for opening the Lexel AI assistant in browser fields.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Hotkey {
    pub modifiers: Vec<String>,
    pub key: String,
}

impl Default for Hotkey {
    fn default() -> Self {
        Self {
            modifiers: vec!["Alt".to_owned()],
            key: "l".to_owned(),
        }
    }
}

fn default_true() -> bool {
    true
}

fn default_language_mode() -> String {
    "plaintext".to_owned()
}

/// Activation guard key for underline popups.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ActivationKey {
    #[default]
    Off,
    Shift,
    Control,
}

/// Supported local AI rewrite tasks.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AiTaskId {
    FixGrammarFlow,
    Deslop,
    RewriteSurface,
    Shorten,
    ReplyDraft,
}

/// Brand or team style guide terminology rule synced across Desktop, Extension, CLI, and LSP.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StyleGuideRule {
    pub term: String,
    pub preferred: String,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub note: Option<String>,
}

/// Personal shortcut trigger that expands automatically while typing (e.g. `;sig` -> signature).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TextSnippet {
    pub trigger: String,
    pub expansion: String,
    #[serde(default)]
    pub label: String,
}

/// User-installed or custom-built Harper `.weirpack` synced across Desktop, CLI, and Browser.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredWeirpack {
    pub name: String,
    pub bytes_base64: String,
    pub rule_count: usize,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

/// Unified per-profile settings synchronized across Extension, Lab, Desktop, and IDE.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedSettings {
    pub theme: String,
    pub ai_enabled: bool,
    pub main_model_tier: MainModelTier,
    pub custom_model: String,
    pub runtime: RuntimeKind,
    pub ollama_endpoint: String,
    #[serde(rename = "openaiCompatEndpoint")]
    pub open_ai_compat_endpoint: String,
    pub temperature: f32,
    pub max_tokens: u32,
    pub idle_unload_secs: u64,
    pub keep_warm: bool,
    pub save_voice_memory: bool,
    pub dialect: u8,
    pub isolate_english: bool,
    pub open_suggestions_on_hover: bool,
    pub activation_key: ActivationKey,
    pub lint_delay_ms: u32,
    #[serde(default = "default_true")]
    pub default_enable: bool,
    #[serde(default)]
    pub hotkey: Hotkey,
    pub lint_config: BTreeMap<String, Option<bool>>,
    pub user_dictionary: Vec<String>,
    pub ignored_lints: String,
    pub privacy_blocklist: Vec<String>,
    pub domain_statuses: BTreeMap<String, bool>,
    pub surface_overrides: BTreeMap<String, String>,
    #[serde(default = "default_language_mode")]
    pub language_mode: String,
    #[serde(default)]
    pub custom_slop_terms: Vec<String>,
    #[serde(default)]
    pub disabled_slop_terms: Vec<String>,
    #[serde(default)]
    pub custom_surfaces: Vec<SurfaceProfile>,
    #[serde(default)]
    pub weirpacks: Vec<StoredWeirpack>,
    #[serde(default)]
    pub style_guide: Vec<StyleGuideRule>,
    #[serde(default)]
    pub snippets: Vec<TextSnippet>,
}

impl Default for UnifiedSettings {
    fn default() -> Self {
        Self {
            theme: "dark".to_owned(),
            ai_enabled: true,
            main_model_tier: MainModelTier::Lexel15B,
            custom_model: "qwen2.5:1.5b".to_owned(),
            runtime: RuntimeKind::Auto,
            ollama_endpoint: "http://127.0.0.1:11434".to_owned(),
            open_ai_compat_endpoint: "http://127.0.0.1:8080".to_owned(),
            temperature: 0.3,
            max_tokens: 280,
            idle_unload_secs: 180,
            keep_warm: false,
            save_voice_memory: true,
            dialect: 0,
            isolate_english: false,
            open_suggestions_on_hover: true,
            activation_key: ActivationKey::Off,
            lint_delay_ms: 0,
            default_enable: true,
            hotkey: Hotkey::default(),
            lint_config: BTreeMap::new(),
            user_dictionary: Vec::new(),
            ignored_lints: String::new(),
            privacy_blocklist: vec![
                "1password.com".to_owned(),
                "bitwarden.com".to_owned(),
                "accounts.google.com".to_owned(),
                "chase.com".to_owned(),
                "bankofamerica.com".to_owned(),
                "paypal.com".to_owned(),
                "stripe.com".to_owned(),
            ],
            domain_statuses: BTreeMap::new(),
            surface_overrides: BTreeMap::new(),
            language_mode: default_language_mode(),
            custom_slop_terms: Vec::new(),
            disabled_slop_terms: Vec::new(),
            custom_surfaces: Vec::new(),
            weirpacks: Vec::new(),
            style_guide: Vec::new(),
            snippets: Vec::new(),
        }
    }
}

impl UnifiedSettings {
    /// Resolve the effective model identifier based on the selected tier.
    pub fn effective_model_name(&self) -> String {
        match self.main_model_tier {
            MainModelTier::Lexel05B => "qwen2.5:0.5b".to_owned(),
            MainModelTier::Lexel15B => "qwen2.5:1.5b".to_owned(),
            MainModelTier::Custom => {
                let trimmed = self.custom_model.trim();
                if trimmed.is_empty() {
                    "qwen2.5:1.5b".to_owned()
                } else {
                    trimmed.to_owned()
                }
            }
        }
    }
}

/// Local profile record representing one shared user configuration across all Lexel surfaces.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LexelProfile {
    pub id: String,
    pub name: String,
    pub is_active: bool,
    pub settings: UnifiedSettings,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Accepted or user-edited rewrite stored in local FTS5 voice memory.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VoiceExample {
    pub id: String,
    pub profile_id: String,
    pub surface_id: String,
    pub subcontext: Option<String>,
    pub original: String,
    pub rewritten: String,
    pub action: String,
    pub created_at: i64,
}
