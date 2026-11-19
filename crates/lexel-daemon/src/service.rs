use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

use lexel_core::{
    AiTaskId, GateCheckSummary, HarperDiagnostic, HarperEngine, HarperRuleInfo, InvisibleCharHit,
    LexelProfile, ReadabilityReport, RulePreset, SafeFixResult, SecretMatch, SlopHit, SlopScanner,
    StoredWeirpack, StructureIssue, StyleGuideHit, SurfaceCatalog, SurfaceViolation,
    UnifiedSettings, VoiceExample, WeirpackValidationSummary, analyze_readability,
    apply_safe_deterministic_fixes, apply_style_guide_fixes, build_custom_weirpack_bytes,
    build_rewrite_messages_with_surfaces, decode_weirpack_base64, encode_weirpack_base64,
    normalize_typography, preset_rule_overrides, sanitize_model_output, scan_invisible_chars,
    scan_secrets, scan_structure_issues, scan_style_guide, structured_lint_config, synonyms_for,
    to_sentence_case, to_title_case, validate_weirpack_bytes, verify_rewrite_with_overrides,
};
use lexel_db::{DatabaseBackup, DbError, DraftSnapshot, LexelDb, WritingStatsSummary};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tracing::info;

use crate::auth::ensure_token;
use crate::models_fs::{
    DownloadModelReport, DownloadProgress, InstalledModelStatus, delete_manifest_model,
    download_manifest_model_with_progress, inspect_installed_models,
};
use crate::runtime::{RuntimeManager, RuntimeSnapshot};

#[derive(Debug, Error)]
pub enum DaemonError {
    #[error("{0}")]
    BadRequest(String),
    #[error("privacy block: {0}")]
    PrivacyBlocked(String),
    #[error("database error: {0}")]
    Db(#[from] DbError),
    #[error("core engine error: {0}")]
    Core(#[from] lexel_core::CoreError),
    #[error("runtime error: {0}")]
    Runtime(String),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStatusPayload {
    pub version: &'static str,
    pub daemon_running: bool,
    pub http_port: u16,
    pub data_dir: String,
    pub models_dir: String,
    pub active_profile: LexelProfile,
    pub profiles: Vec<LexelProfile>,
    pub runtime: RuntimeSnapshot,
    pub models: Vec<InstalledModelStatus>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewriteRequest {
    pub text: String,
    pub task: AiTaskId,
    pub surface_id: String,
    pub subcontext: Option<String>,
    pub thread_context: Option<String>,
    pub domain: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RewriteResponse {
    pub original: String,
    pub suggestion: String,
    pub model: String,
    pub latency_ms: u64,
    pub gates: GateCheckSummary,
    pub surface_id: String,
    pub subcontext: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tier0CheckRequest {
    pub text: String,
    pub surface_id: Option<String>,
    pub domain: Option<String>,
    pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tier0CheckResponse {
    pub harper: Vec<HarperDiagnostic>,
    pub slop: Vec<SlopHit>,
    pub surface: Vec<SurfaceViolation>,
    pub secrets: Vec<SecretMatch>,
    pub invisible_chars: Vec<InvisibleCharHit>,
    pub structure: Vec<StructureIssue>,
    pub style_guide: Vec<StyleGuideHit>,
    pub safe_fixed_text: String,
    pub safe_fixes_count: usize,
    pub blocked: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tier0FixSafeRequest {
    pub text: String,
    pub surface_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleCaseRequest {
    pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SynonymsRequest {
    pub word: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadabilityRequest {
    pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixAllSafeRequest {
    pub text: String,
    pub surface_id: Option<String>,
    pub language: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyPresetRequest {
    pub preset: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildWeirpackRequest {
    pub rule_name: String,
    pub expr: String,
    pub replacement: String,
    pub message: Option<String>,
    pub test_bad: Option<String>,
    pub test_good: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateWeirpackRequest {
    pub name: String,
    pub bytes_base64: String,
    #[serde(default)]
    pub save: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeirpackMutationResponse {
    pub weirpack: StoredWeirpack,
    pub summary: WeirpackValidationSummary,
    pub profile: LexelProfile,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarperRulesPayload {
    pub rules: Vec<HarperRuleInfo>,
    pub lint_config: std::collections::BTreeMap<String, Option<bool>>,
    pub dialect: u8,
    pub isolate_english: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveVoiceRequest {
    pub surface_id: String,
    pub subcontext: Option<String>,
    pub original: String,
    pub rewritten: String,
    pub action: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDraftRequest {
    pub surface_id: Option<String>,
    pub title: Option<String>,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToggleAiResponse {
    pub active_profile: LexelProfile,
    pub activated: bool,
    pub activation_error: Option<String>,
    pub runtime: RuntimeSnapshot,
}

/// Shared service backing HTTP routes, Native Messaging IPC, and CLI commands.
pub struct DaemonService {
    pub data_dir: PathBuf,
    pub token_path: PathBuf,
    pub http_port: u16,
    db: Mutex<LexelDb>,
    runtime: RuntimeManager,
}

impl DaemonService {
    pub fn open(
        data_dir: PathBuf,
        db_path: PathBuf,
        models_dir: PathBuf,
        token_path: PathBuf,
        http_port: u16,
    ) -> Result<Self, DaemonError> {
        let db = LexelDb::open(db_path)?;
        Ok(Self {
            data_dir: data_dir.clone(),
            token_path,
            http_port,
            db: Mutex::new(db),
            runtime: RuntimeManager::new(data_dir, models_dir),
        })
    }

    pub fn open_in_memory(
        data_dir: PathBuf,
        models_dir: PathBuf,
        token_path: PathBuf,
        http_port: u16,
    ) -> Result<Self, DaemonError> {
        let db = LexelDb::open_in_memory()?;
        Ok(Self {
            data_dir: data_dir.clone(),
            token_path,
            http_port,
            db: Mutex::new(db),
            runtime: RuntimeManager::new(data_dir, models_dir),
        })
    }

    pub fn token(&self) -> Result<String, DaemonError> {
        ensure_token(&self.token_path).map_err(|e| DaemonError::Runtime(e.to_string()))
    }

    pub async fn status(&self) -> Result<DaemonStatusPayload, DaemonError> {
        let (active_profile, profiles) = {
            let db = self.db.lock().expect("db mutex poisoned");
            (db.active_profile()?, db.list_profiles()?)
        };
        let runtime = self.runtime.snapshot(&active_profile.settings).await;
        let models = inspect_installed_models(self.runtime.models_dir(), &runtime.ollama_models);
        Ok(DaemonStatusPayload {
            version: env!("CARGO_PKG_VERSION"),
            daemon_running: true,
            http_port: self.http_port,
            data_dir: self.data_dir.display().to_string(),
            models_dir: self.runtime.models_dir().display().to_string(),
            active_profile,
            profiles,
            runtime,
            models,
        })
    }

    pub fn list_profiles(&self) -> Result<(Vec<LexelProfile>, LexelProfile), DaemonError> {
        let db = self.db.lock().expect("db mutex poisoned");
        Ok((db.list_profiles()?, db.active_profile()?))
    }

    pub fn create_profile(
        &self,
        name: &str,
        clone_from_active: bool,
        activate: bool,
    ) -> Result<LexelProfile, DaemonError> {
        let db = self.db.lock().expect("db mutex poisoned");
        Ok(db.create_profile(name, clone_from_active, activate)?)
    }

    pub fn switch_profile(&self, id: &str) -> Result<LexelProfile, DaemonError> {
        let db = self.db.lock().expect("db mutex poisoned");
        Ok(db.switch_profile(id)?)
    }

    pub fn rename_profile(&self, id: &str, name: &str) -> Result<LexelProfile, DaemonError> {
        let db = self.db.lock().expect("db mutex poisoned");
        Ok(db.rename_profile(id, name)?)
    }

    pub fn delete_profile(&self, id: &str) -> Result<LexelProfile, DaemonError> {
        let db = self.db.lock().expect("db mutex poisoned");
        Ok(db.delete_profile(id)?)
    }

    pub fn active_profile(&self) -> Result<LexelProfile, DaemonError> {
        let db = self.db.lock().expect("db mutex poisoned");
        Ok(db.active_profile()?)
    }

    pub fn update_settings(&self, settings: &UnifiedSettings) -> Result<LexelProfile, DaemonError> {
        let db = self.db.lock().expect("db mutex poisoned");
        Ok(db.update_active_settings(settings)?)
    }

    pub fn patch_settings(&self, patch: serde_json::Value) -> Result<LexelProfile, DaemonError> {
        let db = self.db.lock().expect("db mutex poisoned");
        Ok(db.patch_active_settings(patch)?)
    }

    pub async fn toggle_ai(&self, enabled: bool) -> Result<ToggleAiResponse, DaemonError> {
        let profile = {
            let db = self.db.lock().expect("db mutex poisoned");
            db.set_ai_enabled(enabled)?
        };
        let (activated, activation_error) = if enabled {
            match self.runtime.activate(&profile.settings).await {
                Ok(_) => (true, None),
                Err(err) => (false, Some(err)),
            }
        } else {
            self.runtime.unload(&profile.settings).await;
            (false, None)
        };
        let runtime = self.runtime.snapshot(&profile.settings).await;
        Ok(ToggleAiResponse {
            active_profile: profile,
            activated,
            activation_error,
            runtime,
        })
    }

    pub fn set_main_model_persisted(&self, model_spec: &str) -> Result<LexelProfile, DaemonError> {
        let db = self.db.lock().expect("db mutex poisoned");
        Ok(db.set_main_model(model_spec)?)
    }

    pub async fn set_main_model(&self, model_spec: &str) -> Result<ToggleAiResponse, DaemonError> {
        let profile = self.set_main_model_persisted(model_spec)?;
        let (activated, activation_error) = if profile.settings.ai_enabled {
            match self.runtime.activate(&profile.settings).await {
                Ok(_) => (true, None),
                Err(err) => (false, Some(err)),
            }
        } else {
            (false, None)
        };
        let runtime = self.runtime.snapshot(&profile.settings).await;
        Ok(ToggleAiResponse {
            active_profile: profile,
            activated,
            activation_error,
            runtime,
        })
    }

    pub async fn unload_ai(&self) -> Result<RuntimeSnapshot, DaemonError> {
        let profile = self.active_profile()?;
        self.runtime.unload(&profile.settings).await;
        Ok(self.runtime.snapshot(&profile.settings).await)
    }

    pub async fn download_model(&self, model_id: &str) -> Result<DownloadModelReport, DaemonError> {
        self.download_model_with_progress(model_id, |_| {}).await
    }

    pub async fn download_model_with_progress<F>(
        &self,
        model_id: &str,
        on_progress: F,
    ) -> Result<DownloadModelReport, DaemonError>
    where
        F: FnMut(DownloadProgress),
    {
        download_manifest_model_with_progress(self.runtime.models_dir(), model_id, on_progress)
            .await
            .map_err(DaemonError::Runtime)
    }

    pub async fn delete_model(&self, model_id: &str) -> Result<bool, DaemonError> {
        let profile = self.active_profile()?;
        self.runtime.unload(&profile.settings).await;
        delete_manifest_model(self.runtime.models_dir(), model_id).map_err(DaemonError::Runtime)
    }

    pub async fn maybe_idle_unload(&self) {
        if let Ok(profile) = self.active_profile() {
            self.runtime.maybe_idle_unload(&profile.settings).await;
        }
    }

    pub async fn shutdown(&self) {
        if let Ok(profile) = self.active_profile() {
            self.runtime.unload(&profile.settings).await;
        }
    }

    pub async fn rewrite(&self, req: RewriteRequest) -> Result<RewriteResponse, DaemonError> {
        if req.text.trim().is_empty() {
            return Err(DaemonError::BadRequest("Text cannot be empty.".to_owned()));
        }

        let started = Instant::now();
        let (profile, voice_examples) = {
            let db = self.db.lock().expect("db mutex poisoned");
            let profile = db.active_profile()?;
            if let Some(domain) = req.domain.as_deref()
                && is_domain_blocked(domain, &profile.settings.privacy_blocklist)
            {
                return Err(DaemonError::PrivacyBlocked(format!(
                    "AI is blocked on {domain} by your privacy blocklist."
                )));
            }
            let examples = db.search_voice_examples(&req.surface_id, &req.text, 2)?;
            (profile, examples)
        };

        if !profile.settings.ai_enabled {
            return Err(DaemonError::Runtime(
                "Local AI is turned off in Lexel Settings.".to_owned(),
            ));
        }

        let secret_hits = scan_secrets(&req.text);
        if !secret_hits.is_empty() {
            let kinds = secret_hits
                .iter()
                .map(|s| s.label.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            return Err(DaemonError::PrivacyBlocked(format!(
                "Draft contains detected secrets or PII ({kinds}). Remove them before sending to AI."
            )));
        }

        let messages = build_rewrite_messages_with_surfaces(
            &req.text,
            req.task,
            &req.surface_id,
            req.subcontext.as_deref(),
            req.thread_context.as_deref(),
            &voice_examples,
            &profile.settings.custom_surfaces,
        )?;

        let (raw, model_used) = self
            .runtime
            .generate_chat(&profile.settings, &messages)
            .await
            .map_err(DaemonError::Runtime)?;

        let suggestion = sanitize_model_output(&raw);
        let gates = verify_rewrite_with_overrides(
            &req.text,
            &suggestion,
            &req.surface_id,
            profile.settings.dialect,
            &profile.settings.user_dictionary,
            &profile.settings.custom_surfaces,
            &profile.settings.custom_slop_terms,
            &profile.settings.disabled_slop_terms,
        )?;
        let latency_ms = started.elapsed().as_millis() as u64;

        info!(
            surface = %req.surface_id,
            model = %model_used,
            latency_ms,
            zero_slop = gates.zero_slop,
            numbers_preserved = gates.numbers_preserved,
            "completed local AI rewrite"
        );

        Ok(RewriteResponse {
            original: req.text,
            suggestion,
            model: model_used,
            latency_ms,
            gates,
            surface_id: req.surface_id,
            subcontext: req.subcontext,
        })
    }

    pub fn harper_rules(&self) -> Result<HarperRulesPayload, DaemonError> {
        let profile = self.active_profile()?;
        let mut engine = HarperEngine::new(
            profile.settings.dialect,
            &profile.settings.lint_config,
            &profile.settings.user_dictionary,
            &profile.settings.ignored_lints,
        )?;
        engine.load_stored_weirpacks(&profile.settings.weirpacks);
        Ok(HarperRulesPayload {
            rules: engine.rule_catalog(),
            lint_config: profile.settings.lint_config,
            dialect: profile.settings.dialect,
            isolate_english: profile.settings.isolate_english,
        })
    }

    pub fn structured_harper_rules(&self) -> Result<serde_json::Value, DaemonError> {
        Ok(serde_json::to_value(structured_lint_config()).map_err(DbError::from)?)
    }

    pub fn fix_safe(&self, req: Tier0FixSafeRequest) -> Result<SafeFixResult, DaemonError> {
        let profile = self.active_profile()?;
        let surface_id = req.surface_id.as_deref().unwrap_or("general");
        let base = apply_safe_deterministic_fixes(
            &req.text,
            surface_id,
            &profile.settings.custom_slop_terms,
            &profile.settings.disabled_slop_terms,
            &profile.settings.custom_surfaces,
        )?;
        let styled = apply_style_guide_fixes(&base.text, &profile.settings.style_guide);
        let mut categories = base.categories;
        for c in styled.categories {
            if !categories.contains(&c) {
                categories.push(c);
            }
        }
        Ok(SafeFixResult {
            text: styled.text,
            fixes_applied: base.fixes_applied + styled.fixes_applied,
            categories,
        })
    }

    pub fn title_case(&self, text: &str) -> String {
        to_title_case(text)
    }

    pub fn sentence_case(&self, text: &str) -> String {
        to_sentence_case(text)
    }

    pub fn normalize_typography_text(&self, text: &str) -> SafeFixResult {
        normalize_typography(text)
    }

    pub fn readability(&self, text: &str) -> ReadabilityReport {
        analyze_readability(text)
    }

    pub fn fix_all_safe(&self, req: FixAllSafeRequest) -> Result<SafeFixResult, DaemonError> {
        let profile = self.active_profile()?;
        let surface_id = req.surface_id.as_deref().unwrap_or("general");
        let language = req.language.as_deref().unwrap_or("plaintext");

        let deterministic = apply_safe_deterministic_fixes(
            &req.text,
            surface_id,
            &profile.settings.custom_slop_terms,
            &profile.settings.disabled_slop_terms,
            &profile.settings.custom_surfaces,
        )?;
        let styled = apply_style_guide_fixes(&deterministic.text, &profile.settings.style_guide);

        let mut engine = HarperEngine::new(
            profile.settings.dialect,
            &profile.settings.lint_config,
            &profile.settings.user_dictionary,
            &profile.settings.ignored_lints,
        )?;
        engine.load_stored_weirpacks(&profile.settings.weirpacks);
        let grammar = engine.apply_safe_harper_fixes(&styled.text, language);

        let mut categories = deterministic.categories;
        for cat in styled.categories.into_iter().chain(grammar.categories) {
            if !categories.contains(&cat) {
                categories.push(cat);
            }
        }

        let total_fixes =
            deterministic.fixes_applied + styled.fixes_applied + grammar.fixes_applied;
        if total_fixes > 0 {
            let words = req.text.split_whitespace().count();
            if let Ok(db) = self.db.lock() {
                let _ = db.record_writing_event(surface_id, words, 0, 0, 0, total_fixes);
            }
        }

        Ok(SafeFixResult {
            text: grammar.text,
            fixes_applied: total_fixes,
            categories,
        })
    }

    pub fn apply_rule_preset(&self, preset_raw: &str) -> Result<LexelProfile, DaemonError> {
        let preset = RulePreset::parse(preset_raw).ok_or_else(|| {
            DaemonError::BadRequest(format!("Unknown Harper preset: {preset_raw}"))
        })?;
        let mut settings = self.active_profile()?.settings;
        if preset == RulePreset::Curated {
            settings.lint_config.clear();
        } else {
            for (k, v) in preset_rule_overrides(preset) {
                settings.lint_config.insert(k, v);
            }
        }
        self.update_settings(&settings)
    }

    pub fn synonyms(&self, word: &str) -> Vec<String> {
        synonyms_for(word)
    }

    pub fn build_custom_weirpack(
        &self,
        req: BuildWeirpackRequest,
    ) -> Result<WeirpackMutationResponse, DaemonError> {
        let (name, bytes, summary) = build_custom_weirpack_bytes(
            &req.rule_name,
            &req.expr,
            &req.replacement,
            req.message.as_deref(),
            req.test_bad.as_deref(),
            req.test_good.as_deref(),
        )
        .map_err(|err| DaemonError::BadRequest(err.to_string()))?;

        let stored = StoredWeirpack {
            name: name.clone(),
            bytes_base64: encode_weirpack_base64(&bytes),
            rule_count: summary.rule_count,
            enabled: true,
        };

        let mut settings = self.active_profile()?.settings;
        settings.weirpacks.retain(|p| p.name != name);
        settings.weirpacks.push(stored.clone());
        let profile = self.update_settings(&settings)?;
        Ok(WeirpackMutationResponse {
            weirpack: stored,
            summary,
            profile,
        })
    }

    pub fn validate_weirpack(
        &self,
        req: ValidateWeirpackRequest,
    ) -> Result<WeirpackMutationResponse, DaemonError> {
        let bytes = decode_weirpack_base64(&req.bytes_base64)
            .map_err(|err| DaemonError::BadRequest(err.to_string()))?;
        let summary = validate_weirpack_bytes(&bytes)
            .map_err(|err| DaemonError::BadRequest(err.to_string()))?;
        if !summary.failures.is_empty() {
            return Err(DaemonError::BadRequest(format!(
                "Weirpack failed embedded tests: {:?}",
                summary.failures
            )));
        }

        let name = if req.name.trim().is_empty() {
            "custom.weirpack".to_owned()
        } else {
            req.name.trim().to_owned()
        };
        let stored = StoredWeirpack {
            name: name.clone(),
            bytes_base64: req.bytes_base64.trim().to_owned(),
            rule_count: summary.rule_count,
            enabled: true,
        };

        let profile = if req.save {
            let mut settings = self.active_profile()?.settings;
            settings.weirpacks.retain(|p| p.name != name);
            settings.weirpacks.push(stored.clone());
            self.update_settings(&settings)?
        } else {
            self.active_profile()?
        };

        Ok(WeirpackMutationResponse {
            weirpack: stored,
            summary,
            profile,
        })
    }

    pub fn tier0_check(&self, req: Tier0CheckRequest) -> Result<Tier0CheckResponse, DaemonError> {
        let profile = self.active_profile()?;
        if let Some(domain) = req.domain.as_deref()
            && is_domain_blocked(domain, &profile.settings.privacy_blocklist)
        {
            return Ok(Tier0CheckResponse {
                harper: Vec::new(),
                slop: Vec::new(),
                surface: Vec::new(),
                secrets: Vec::new(),
                invisible_chars: Vec::new(),
                structure: Vec::new(),
                style_guide: Vec::new(),
                safe_fixed_text: req.text,
                safe_fixes_count: 0,
                blocked: true,
            });
        }

        let surface_id = req.surface_id.as_deref().unwrap_or("general");
        let catalog = SurfaceCatalog::load_with_custom(&profile.settings.custom_surfaces)?;
        let surface_profile = catalog.get(surface_id)?;
        let slop_scanner = SlopScanner::load_embedded()?;
        let mut engine = HarperEngine::new(
            profile.settings.dialect,
            &profile.settings.lint_config,
            &profile.settings.user_dictionary,
            &profile.settings.ignored_lints,
        )?;
        engine.load_stored_weirpacks(&profile.settings.weirpacks);
        let language = req
            .language
            .as_deref()
            .unwrap_or(&profile.settings.language_mode);
        let safe_fix = apply_safe_deterministic_fixes(
            &req.text,
            surface_id,
            &profile.settings.custom_slop_terms,
            &profile.settings.disabled_slop_terms,
            &profile.settings.custom_surfaces,
        )?;
        let style_fix = apply_style_guide_fixes(&safe_fix.text, &profile.settings.style_guide);

        let harper = engine.check_text_with_language(&req.text, language);
        let slop = slop_scanner.scan_with_overrides(
            &req.text,
            surface_profile.allow_em_dashes,
            &profile.settings.custom_slop_terms,
            &profile.settings.disabled_slop_terms,
        );
        let surface = catalog.validate(&req.text, surface_id)?;
        let secrets = scan_secrets(&req.text);
        let invisible_chars = scan_invisible_chars(&req.text);
        let structure = scan_structure_issues(&req.text);
        let style_guide = scan_style_guide(&req.text, &profile.settings.style_guide);

        let words = req.text.split_whitespace().count();
        if words > 0
            && let Ok(db) = self.db.lock()
        {
            let _ = db.record_writing_event(
                surface_id,
                words,
                harper.len(),
                slop.len(),
                secrets.len(),
                0,
            );
        }

        Ok(Tier0CheckResponse {
            harper,
            slop,
            surface,
            secrets,
            invisible_chars,
            structure,
            style_guide,
            safe_fixed_text: style_fix.text,
            safe_fixes_count: safe_fix.fixes_applied + style_fix.fixes_applied,
            blocked: false,
        })
    }

    pub fn list_voice_examples(
        &self,
        surface_id: Option<&str>,
    ) -> Result<Vec<VoiceExample>, DaemonError> {
        let db = self.db.lock().expect("db mutex poisoned");
        Ok(db.list_voice_examples(surface_id, 150)?)
    }

    pub fn save_voice_example(&self, req: SaveVoiceRequest) -> Result<VoiceExample, DaemonError> {
        let db = self.db.lock().expect("db mutex poisoned");
        Ok(db.save_voice_example(
            &req.surface_id,
            req.subcontext.as_deref(),
            &req.original,
            &req.rewritten,
            req.action.as_deref().unwrap_or("accepted"),
        )?)
    }

    pub fn delete_voice_example(&self, id: &str) -> Result<bool, DaemonError> {
        let db = self.db.lock().expect("db mutex poisoned");
        Ok(db.delete_voice_example(id)?)
    }

    pub fn writing_stats(&self) -> Result<WritingStatsSummary, DaemonError> {
        let db = self.db.lock().expect("db mutex poisoned");
        Ok(db.writing_stats_summary()?)
    }

    pub fn list_drafts(&self) -> Result<Vec<DraftSnapshot>, DaemonError> {
        let db = self.db.lock().expect("db mutex poisoned");
        Ok(db.list_draft_snapshots(50)?)
    }

    pub fn save_draft(&self, req: SaveDraftRequest) -> Result<DraftSnapshot, DaemonError> {
        if req.content.trim().is_empty() {
            return Err(DaemonError::BadRequest(
                "Draft content cannot be empty.".to_owned(),
            ));
        }
        let db = self.db.lock().expect("db mutex poisoned");
        Ok(db.save_draft_snapshot(
            req.surface_id.as_deref().unwrap_or("general"),
            req.title.as_deref(),
            &req.content,
        )?)
    }

    pub fn delete_draft(&self, id: &str) -> Result<bool, DaemonError> {
        let db = self.db.lock().expect("db mutex poisoned");
        Ok(db.delete_draft_snapshot(id)?)
    }

    pub fn export_backup(&self) -> Result<DatabaseBackup, DaemonError> {
        let db = self.db.lock().expect("db mutex poisoned");
        Ok(db.export_backup()?)
    }

    pub fn import_backup(&self, backup: DatabaseBackup) -> Result<LexelProfile, DaemonError> {
        let db = self.db.lock().expect("db mutex poisoned");
        Ok(db.import_backup(backup)?)
    }

    pub async fn purge_all(&self) -> Result<LexelProfile, DaemonError> {
        let profile = {
            let db = self.db.lock().expect("db mutex poisoned");
            db.purge_all()?
        };
        self.runtime.unload(&profile.settings).await;
        Ok(profile)
    }

    /// Unified RPC dispatcher shared by Chrome/Firefox Native Messaging.
    pub async fn dispatch_rpc(
        &self,
        kind: &str,
        payload: serde_json::Value,
    ) -> Result<serde_json::Value, DaemonError> {
        match kind {
            "health" => Ok(serde_json::json!({
                "ok": true,
                "version": env!("CARGO_PKG_VERSION"),
                "httpPort": self.http_port,
            })),
            "status" => Ok(serde_json::to_value(self.status().await?).map_err(DbError::from)?),
            "getDaemonConnection" => Ok(serde_json::json!({
                "endpoint": format!("http://127.0.0.1:{}", self.http_port),
                "token": self.token()?,
            })),
            "listProfiles" => {
                let (profiles, active) = self.list_profiles()?;
                Ok(serde_json::json!({ "profiles": profiles, "activeProfile": active }))
            }
            "createProfile" => {
                let name = payload
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Profile");
                let clone = payload
                    .get("cloneFromActive")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let activate = payload
                    .get("activate")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let created = self.create_profile(name, clone, activate)?;
                Ok(serde_json::to_value(created).map_err(DbError::from)?)
            }
            "switchProfile" => {
                let id = payload
                    .get("profileId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| DaemonError::BadRequest("missing profileId".to_owned()))?;
                Ok(serde_json::to_value(self.switch_profile(id)?).map_err(DbError::from)?)
            }
            "renameProfile" => {
                let id = payload
                    .get("profileId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| DaemonError::BadRequest("missing profileId".to_owned()))?;
                let name = payload
                    .get("name")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| DaemonError::BadRequest("missing name".to_owned()))?;
                Ok(serde_json::to_value(self.rename_profile(id, name)?).map_err(DbError::from)?)
            }
            "deleteProfile" => {
                let id = payload
                    .get("profileId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| DaemonError::BadRequest("missing profileId".to_owned()))?;
                Ok(serde_json::to_value(self.delete_profile(id)?).map_err(DbError::from)?)
            }
            "getSettings" => {
                let profile = self.active_profile()?;
                Ok(serde_json::json!({ "profile": profile, "settings": profile.settings }))
            }
            "updateSettings" => {
                let settings_val = payload.get("settings").cloned().unwrap_or(payload);
                let parsed: UnifiedSettings =
                    serde_json::from_value(settings_val).map_err(DbError::from)?;
                let profile = self.update_settings(&parsed)?;
                Ok(serde_json::json!({ "profile": profile, "settings": profile.settings }))
            }
            "patchSettings" => {
                let patch = payload.get("patch").cloned().unwrap_or(payload);
                let profile = self.patch_settings(patch)?;
                Ok(serde_json::json!({ "profile": profile, "settings": profile.settings }))
            }
            "toggleAi" => {
                let enabled = payload
                    .get("enabled")
                    .and_then(|v| v.as_bool())
                    .ok_or_else(|| DaemonError::BadRequest("missing enabled bool".to_owned()))?;
                Ok(serde_json::to_value(self.toggle_ai(enabled).await?).map_err(DbError::from)?)
            }
            "setMainModel" => {
                let model = payload
                    .get("model")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| DaemonError::BadRequest("missing model".to_owned()))?;
                Ok(serde_json::to_value(self.set_main_model(model).await?)
                    .map_err(DbError::from)?)
            }
            "unloadAi" => Ok(serde_json::to_value(self.unload_ai().await?).map_err(DbError::from)?),
            "downloadModel" => {
                let model_id = payload
                    .get("modelId")
                    .or_else(|| payload.get("model"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("lexel-1.5b");
                Ok(serde_json::to_value(self.download_model(model_id).await?)
                    .map_err(DbError::from)?)
            }
            "deleteModel" => {
                let model_id = payload
                    .get("modelId")
                    .or_else(|| payload.get("model"))
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| DaemonError::BadRequest("missing modelId".to_owned()))?;
                Ok(serde_json::json!({ "deleted": self.delete_model(model_id).await? }))
            }
            "rewrite" | "aiRewrite" => {
                let req: RewriteRequest = serde_json::from_value(payload).map_err(DbError::from)?;
                Ok(serde_json::to_value(self.rewrite(req).await?).map_err(DbError::from)?)
            }
            "harperRules" => Ok(serde_json::to_value(self.harper_rules()?).map_err(DbError::from)?),
            "structuredHarperRules" => self.structured_harper_rules(),
            "tier0Check" => {
                let req: Tier0CheckRequest =
                    serde_json::from_value(payload).map_err(DbError::from)?;
                Ok(serde_json::to_value(self.tier0_check(req)?).map_err(DbError::from)?)
            }
            "fixSafe" => {
                let req: Tier0FixSafeRequest =
                    serde_json::from_value(payload).map_err(DbError::from)?;
                Ok(serde_json::to_value(self.fix_safe(req)?).map_err(DbError::from)?)
            }
            "titleCase" => {
                let req: TitleCaseRequest =
                    serde_json::from_value(payload).map_err(DbError::from)?;
                Ok(serde_json::json!({ "text": self.title_case(&req.text) }))
            }
            "sentenceCase" => {
                let req: TitleCaseRequest =
                    serde_json::from_value(payload).map_err(DbError::from)?;
                Ok(serde_json::json!({ "text": self.sentence_case(&req.text) }))
            }
            "normalizeTypography" => {
                let req: TitleCaseRequest =
                    serde_json::from_value(payload).map_err(DbError::from)?;
                Ok(
                    serde_json::to_value(self.normalize_typography_text(&req.text))
                        .map_err(DbError::from)?,
                )
            }
            "readability" => {
                let req: ReadabilityRequest =
                    serde_json::from_value(payload).map_err(DbError::from)?;
                Ok(serde_json::to_value(self.readability(&req.text)).map_err(DbError::from)?)
            }
            "fixAllSafe" => {
                let req: FixAllSafeRequest =
                    serde_json::from_value(payload).map_err(DbError::from)?;
                Ok(serde_json::to_value(self.fix_all_safe(req)?).map_err(DbError::from)?)
            }
            "applyRulePreset" => {
                let req: ApplyPresetRequest =
                    serde_json::from_value(payload).map_err(DbError::from)?;
                Ok(serde_json::to_value(self.apply_rule_preset(&req.preset)?)
                    .map_err(DbError::from)?)
            }
            "buildWeirpack" => {
                let req: BuildWeirpackRequest =
                    serde_json::from_value(payload).map_err(DbError::from)?;
                Ok(
                    serde_json::to_value(self.build_custom_weirpack(req)?)
                        .map_err(DbError::from)?,
                )
            }
            "validateWeirpack" => {
                let req: ValidateWeirpackRequest =
                    serde_json::from_value(payload).map_err(DbError::from)?;
                Ok(serde_json::to_value(self.validate_weirpack(req)?).map_err(DbError::from)?)
            }
            "synonyms" => {
                let req: SynonymsRequest =
                    serde_json::from_value(payload).map_err(DbError::from)?;
                Ok(serde_json::json!({ "synonyms": self.synonyms(&req.word) }))
            }
            "listVoiceExamples" => {
                let surface = payload.get("surfaceId").and_then(|v| v.as_str());
                Ok(serde_json::json!({ "examples": self.list_voice_examples(surface)? }))
            }
            "saveVoiceExample" => {
                let raw = payload.get("example").cloned().unwrap_or(payload);
                let req: SaveVoiceRequest = serde_json::from_value(raw).map_err(DbError::from)?;
                Ok(serde_json::json!({ "example": self.save_voice_example(req)? }))
            }
            "deleteVoiceExample" => {
                let id = payload
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| DaemonError::BadRequest("missing id".to_owned()))?;
                Ok(serde_json::json!({ "deleted": self.delete_voice_example(id)? }))
            }
            "writingStats" => {
                Ok(serde_json::to_value(self.writing_stats()?).map_err(DbError::from)?)
            }
            "listDrafts" => Ok(serde_json::json!({ "drafts": self.list_drafts()? })),
            "saveDraft" => {
                let raw = payload.get("draft").cloned().unwrap_or(payload);
                let req: SaveDraftRequest = serde_json::from_value(raw).map_err(DbError::from)?;
                Ok(serde_json::json!({ "draft": self.save_draft(req)? }))
            }
            "deleteDraft" => {
                let id = payload
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| DaemonError::BadRequest("missing id".to_owned()))?;
                Ok(serde_json::json!({ "deleted": self.delete_draft(id)? }))
            }
            "exportBackup" => {
                Ok(serde_json::to_value(self.export_backup()?).map_err(DbError::from)?)
            }
            "importBackup" => {
                let raw = payload.get("backup").cloned().unwrap_or(payload);
                let backup: DatabaseBackup = serde_json::from_value(raw).map_err(DbError::from)?;
                Ok(serde_json::to_value(self.import_backup(backup)?).map_err(DbError::from)?)
            }
            "purgeAll" => Ok(serde_json::to_value(self.purge_all().await?).map_err(DbError::from)?),
            other => Err(DaemonError::BadRequest(format!(
                "Unknown RPC kind: {other}"
            ))),
        }
    }
}

fn is_domain_blocked(hostname: &str, patterns: &[String]) -> bool {
    let host = hostname.trim().to_ascii_lowercase();
    patterns.iter().any(|pat| {
        let p = pat.trim().to_ascii_lowercase();
        if p.is_empty() {
            false
        } else if p == "*" {
            true
        } else if let Some(suffix) = p.strip_prefix("*.") {
            host == suffix || host.ends_with(&format!(".{suffix}"))
        } else {
            host == p
        }
    })
}
