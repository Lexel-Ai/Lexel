use serde::{Deserialize, Serialize};

use crate::CoreError;

const MANIFEST_JSON: &str = include_str!("../../../models/manifest.json");

/// Metadata for one downloadable local GGUF model tier.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpec {
    pub id: String,
    pub tier: String,
    pub label: String,
    pub description: String,
    pub ollama_tag: String,
    pub gguf_repo: String,
    pub gguf_filename: String,
    pub gguf_url: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub approx_ram_mb: u64,
}

/// Embedded model catalog loaded from `models/manifest.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelManifest {
    pub version: u32,
    pub default_main_model: String,
    pub models: Vec<ModelSpec>,
}

impl ModelManifest {
    /// Load the canonical model manifest bundled from `models/manifest.json`.
    pub fn load_embedded() -> Result<Self, CoreError> {
        Ok(serde_json::from_str(MANIFEST_JSON)?)
    }

    /// Look up a model tier by id (`lexel-0.5b`, `lexel-1.5b`) or short alias (`0.5b`, `1.5b`).
    pub fn find(&self, id_or_alias: &str) -> Option<&ModelSpec> {
        let lower = id_or_alias.trim().to_ascii_lowercase();
        let normalized = match lower.as_str() {
            "0.5b" | "lite" => "lexel-0.5b",
            "1.5b" | "standard" => "lexel-1.5b",
            other => other,
        };
        self.models
            .iter()
            .find(|m| m.id.eq_ignore_ascii_case(normalized))
    }
}

/// Convenience helper returning the parsed manifest.
pub fn default_model_manifest() -> Result<ModelManifest, CoreError> {
    ModelManifest::load_embedded()
}
