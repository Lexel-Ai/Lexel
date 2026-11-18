use std::path::{Path, PathBuf};

use lexel_core::{MainModelTier, ModelManifest, UnifiedSettings};
use serde::{Deserialize, Serialize};

/// Status of one local model tier on disk and/or in Ollama.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledModelStatus {
    pub id: String,
    pub tier: String,
    pub label: String,
    pub description: String,
    pub ollama_tag: String,
    pub gguf_filename: String,
    pub gguf_path: String,
    pub gguf_installed: bool,
    pub gguf_size_valid: bool,
    pub ollama_installed: bool,
    pub approx_ram_mb: u64,
    pub size_bytes: u64,
}

/// Inspect which manifest models (`0.5B` and `1.5B`) exist locally in `models_dir`.
pub fn inspect_installed_models(
    models_dir: &Path,
    ollama_models: &[String],
) -> Vec<InstalledModelStatus> {
    let Ok(manifest) = ModelManifest::load_embedded() else {
        return Vec::new();
    };

    manifest
        .models
        .into_iter()
        .map(|spec| {
            let path = models_dir.join(&spec.gguf_filename);
            let meta = std::fs::metadata(&path).ok();
            let gguf_installed = meta.as_ref().is_some_and(|m| m.is_file());
            let gguf_size_valid = meta.as_ref().is_some_and(|m| m.len() == spec.size_bytes);
            let ollama_installed = ollama_has_tag(&spec.ollama_tag, ollama_models)
                || ollama_has_tag(&spec.id, ollama_models);

            InstalledModelStatus {
                id: spec.id,
                tier: spec.tier,
                label: spec.label,
                description: spec.description,
                ollama_tag: spec.ollama_tag,
                gguf_filename: spec.gguf_filename,
                gguf_path: path.display().to_string(),
                gguf_installed,
                gguf_size_valid,
                ollama_installed,
                approx_ram_mb: spec.approx_ram_mb,
                size_bytes: spec.size_bytes,
            }
        })
        .collect()
}

/// Resolve the local GGUF file path for the currently configured `UnifiedSettings`.
pub fn resolve_gguf_path(models_dir: &Path, settings: &UnifiedSettings) -> Option<PathBuf> {
    let manifest = ModelManifest::load_embedded().ok()?;
    match settings.main_model_tier {
        MainModelTier::Lexel05B => {
            let spec = manifest.find("lexel-0.5b")?;
            let path = models_dir.join(&spec.gguf_filename);
            path.is_file().then_some(path)
        }
        MainModelTier::Lexel15B => {
            let spec = manifest.find("lexel-1.5b")?;
            let path = models_dir.join(&spec.gguf_filename);
            path.is_file().then_some(path)
        }
        MainModelTier::Custom => {
            let candidate = PathBuf::from(settings.custom_model.trim());
            if candidate.is_file() {
                return Some(candidate);
            }
            let relative = models_dir.join(settings.custom_model.trim());
            relative.is_file().then_some(relative)
        }
    }
}

/// Check whether a target Ollama tag or `:latest` variant appears in `/api/tags`.
pub fn ollama_has_tag(target: &str, available: &[String]) -> bool {
    let norm = target.trim().to_ascii_lowercase();
    if norm.is_empty() {
        return false;
    }
    available.iter().any(|item| {
        let cand = item.trim().to_ascii_lowercase();
        cand == norm || cand == format!("{norm}:latest") || format!("{cand}:latest") == norm
    })
}
