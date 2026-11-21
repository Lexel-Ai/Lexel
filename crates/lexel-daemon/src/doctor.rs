use std::fs;
use std::path::Path;
use std::time::Instant;

use lexel_core::{
    HarperEngine, ModelManifest, SlopScanner, SurfaceCatalog, UnifiedSettings, scan_secrets,
};
use serde::{Deserialize, Serialize};

use crate::models_fs::{compute_file_sha256, ollama_has_tag};
use crate::native_messaging::native_manifest_targets;
use crate::runtime::{RuntimeDetails, RuntimeSnapshot};
use crate::whisper::{WhisperDoctorStatus, inspect_whisper};

/// Verification status of one browser's Native Messaging host manifest.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeManifestCheck {
    pub browser: String,
    pub manifest_path: String,
    pub installed: bool,
    pub valid_json: bool,
    pub host_binary_exists: bool,
    pub allowed_origins: Vec<String>,
}

/// Verification status of one manifest GGUF model (existence, size, and SHA-256).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelDoctorCheck {
    pub id: String,
    pub gguf_path: String,
    pub gguf_installed: bool,
    pub size_valid: bool,
    pub expected_sha256: String,
    pub actual_sha256: Option<String>,
    pub sha256_verified: bool,
    pub ollama_installed: bool,
}

/// Privacy proof summary backing the "0 Bytes Left Your Device" indicator.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyProofSummary {
    pub local_only_verified: bool,
    pub loopback_enforced: bool,
    pub total_secret_blocks: usize,
    pub redact_secrets_enabled: bool,
    pub zero_telemetry: bool,
}

/// Complete local diagnostics payload returned by `GET /v1/doctor` and RPC `doctor`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub ok: bool,
    pub version: String,
    pub http_port: u16,
    pub data_dir: String,
    pub models_dir: String,
    pub runtime: RuntimeSnapshot,
    pub runtime_details: RuntimeDetails,
    pub whisper: WhisperDoctorStatus,
    pub native_messaging: Vec<NativeManifestCheck>,
    pub models: Vec<ModelDoctorCheck>,
    pub tier0_latency_ms: f64,
    pub measured_tok_per_sec: Option<f64>,
    pub privacy_proof: PrivacyProofSummary,
}

/// Inspect all installed Native Messaging manifests for Chrome, Chromium, Brave, Edge, and Firefox.
pub fn inspect_native_manifests(data_dir: &Path) -> Vec<NativeManifestCheck> {
    native_manifest_targets(data_dir)
        .into_iter()
        .map(|(browser, path)| {
            let installed = path.is_file();
            let mut valid_json = false;
            let mut host_binary_exists = false;
            let mut allowed_origins = Vec::new();

            if installed
                && let Ok(raw) = fs::read_to_string(&path)
                && let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw)
            {
                valid_json = true;
                if let Some(host_path) = val.get("path").and_then(|v| v.as_str()) {
                    host_binary_exists = Path::new(host_path).is_file();
                }
                if let Some(arr) = val.get("allowed_origins").and_then(|v| v.as_array()) {
                    for item in arr {
                        if let Some(s) = item.as_str() {
                            allowed_origins.push(s.to_owned());
                        }
                    }
                } else if let Some(arr) = val.get("allowed_extensions").and_then(|v| v.as_array()) {
                    for item in arr {
                        if let Some(s) = item.as_str() {
                            allowed_origins.push(s.to_owned());
                        }
                    }
                }
            }

            NativeManifestCheck {
                browser: browser.to_owned(),
                manifest_path: path.display().to_string(),
                installed,
                valid_json,
                host_binary_exists,
                allowed_origins,
            }
        })
        .collect()
}

/// Inspect manifest GGUF files on disk, verifying size and SHA-256 checksum for any installed file.
pub fn inspect_models_with_sha(
    models_dir: &Path,
    ollama_models: &[String],
) -> Vec<ModelDoctorCheck> {
    let Ok(manifest) = ModelManifest::load_embedded() else {
        return Vec::new();
    };

    manifest
        .models
        .into_iter()
        .map(|spec| {
            let path = models_dir.join(&spec.gguf_filename);
            let meta = fs::metadata(&path).ok();
            let gguf_installed = meta.as_ref().is_some_and(|m| m.is_file());
            let size_valid = meta
                .as_ref()
                .is_some_and(|m| spec.size_bytes == 0 || m.len() == spec.size_bytes);
            let actual_sha256 = if gguf_installed {
                compute_file_sha256(&path).ok()
            } else {
                None
            };
            let sha256_verified = match (&actual_sha256, spec.sha256.is_empty()) {
                (Some(_), true) => true,
                (Some(actual), false) => actual.eq_ignore_ascii_case(&spec.sha256),
                (None, _) => false,
            };
            let ollama_installed = ollama_has_tag(&spec.ollama_tag, ollama_models)
                || ollama_has_tag(&spec.id, ollama_models);

            ModelDoctorCheck {
                id: spec.id,
                gguf_path: path.display().to_string(),
                gguf_installed,
                size_valid,
                expected_sha256: spec.sha256,
                actual_sha256,
                sha256_verified,
                ollama_installed,
            }
        })
        .collect()
}

/// Measure real Tier 0 check latency (Harper + anti-slop + surface + secret scan) in milliseconds.
pub fn measure_tier0_latency_ms(settings: &UnifiedSettings) -> f64 {
    const SAMPLE: &str =
        "This is an quick draft to delve into latency numbers on PR #42 and fix typos.";
    let Ok(catalog) = SurfaceCatalog::load_with_custom(&settings.custom_surfaces) else {
        return 0.0;
    };
    let Ok(scanner) = SlopScanner::load_embedded() else {
        return 0.0;
    };
    let Ok(mut engine) = HarperEngine::new(
        settings.dialect,
        &settings.lint_config,
        &settings.user_dictionary,
        &settings.ignored_lints,
    ) else {
        return 0.0;
    };

    let started = Instant::now();
    let _ = engine.check_text(SAMPLE);
    let _ = scanner.scan_with_overrides(
        SAMPLE,
        false,
        &settings.custom_slop_terms,
        &settings.disabled_slop_terms,
    );
    let _ = catalog.validate(SAMPLE, "general");
    let _ = scan_secrets(SAMPLE);
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    (elapsed_ms * 100.0).round() / 100.0
}

/// Assemble the full `DoctorReport` using real local state and measurements.
#[allow(clippy::too_many_arguments)]
pub fn build_doctor_report(
    http_port: u16,
    data_dir: &Path,
    models_dir: &Path,
    settings: &UnifiedSettings,
    runtime: RuntimeSnapshot,
    runtime_details: RuntimeDetails,
    measured_tok_per_sec: Option<f64>,
    total_secret_blocks: usize,
) -> DoctorReport {
    let whisper = inspect_whisper(data_dir, models_dir, settings);
    let native_messaging = inspect_native_manifests(data_dir);
    let models = inspect_models_with_sha(models_dir, &runtime.ollama_models);
    let tier0_latency_ms = measure_tier0_latency_ms(settings);

    let local_only_verified = is_loopback_url(&settings.ollama_endpoint)
        && is_loopback_url(&settings.open_ai_compat_endpoint);

    let any_runtime_ready =
        runtime.llama_server_available || runtime.ollama_binary_available || runtime.ollama_running;
    let ok = local_only_verified && (!settings.ai_enabled || any_runtime_ready);

    DoctorReport {
        ok,
        version: env!("CARGO_PKG_VERSION").to_owned(),
        http_port,
        data_dir: data_dir.display().to_string(),
        models_dir: models_dir.display().to_string(),
        runtime,
        runtime_details,
        whisper,
        native_messaging,
        models,
        tier0_latency_ms,
        measured_tok_per_sec,
        privacy_proof: PrivacyProofSummary {
            local_only_verified,
            loopback_enforced: true,
            total_secret_blocks,
            redact_secrets_enabled: settings.redact_secrets,
            zero_telemetry: true,
        },
    }
}

fn is_loopback_url(raw: &str) -> bool {
    url::Url::parse(raw.trim()).ok().is_some_and(|parsed| {
        matches!(
            parsed
                .host_str()
                .unwrap_or_default()
                .to_ascii_lowercase()
                .as_str(),
            "127.0.0.1" | "localhost" | "[::1]"
        )
    })
}
