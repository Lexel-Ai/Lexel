use std::fmt::Write as _;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use lexel_core::{MainModelTier, ModelManifest, ModelSpec, UnifiedSettings};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

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

/// Incremental progress update emitted while streaming a GGUF artifact.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub model_id: String,
    pub bytes_downloaded: u64,
    pub total_bytes: u64,
    pub percent: u8,
}

/// Result returned after downloading or verifying a manifest GGUF model.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadModelReport {
    pub id: String,
    pub gguf_path: String,
    pub bytes_downloaded: u64,
    pub sha256: String,
    pub verified: bool,
    pub already_present: bool,
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
            let meta = fs::metadata(&path).ok();
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

/// Download a manifest model by ID or alias (`lexel-0.5b`, `0.5b`, `lexel-1.5b`, `1.5b`) and verify SHA-256.
pub async fn download_manifest_model(
    models_dir: &Path,
    model_id: &str,
) -> Result<DownloadModelReport, String> {
    download_manifest_model_with_progress(models_dir, model_id, |_| {}).await
}

/// Download a manifest model while streaming `DownloadProgress` updates to `on_progress`.
pub async fn download_manifest_model_with_progress<F>(
    models_dir: &Path,
    model_id: &str,
    on_progress: F,
) -> Result<DownloadModelReport, String>
where
    F: FnMut(DownloadProgress),
{
    let manifest = ModelManifest::load_embedded().map_err(|e| e.to_string())?;
    let spec = manifest
        .find(model_id)
        .ok_or_else(|| format!("Unknown model id: {model_id}"))?
        .clone();
    download_model_spec_with_progress(models_dir, &spec, on_progress).await
}

/// Delete a downloaded manifest GGUF file (and any partial `.part` file) to free local disk space.
pub fn delete_manifest_model(models_dir: &Path, model_id: &str) -> Result<bool, String> {
    let manifest = ModelManifest::load_embedded().map_err(|e| e.to_string())?;
    let spec = manifest
        .find(model_id)
        .ok_or_else(|| format!("Unknown model id: {model_id}"))?;
    let dest = models_dir.join(&spec.gguf_filename);
    let part = models_dir.join(format!("{}.part", spec.gguf_filename));
    let mut removed = false;
    if dest.is_file() {
        fs::remove_file(&dest).map_err(|e| format!("failed to delete model file: {e}"))?;
        removed = true;
    }
    if part.is_file() {
        let _ = fs::remove_file(&part);
        removed = true;
    }
    Ok(removed)
}

/// Stream a `ModelSpec` GGUF artifact to `models_dir`, verify its size and SHA-256, and commit atomically.
pub async fn download_model_spec(
    models_dir: &Path,
    spec: &ModelSpec,
) -> Result<DownloadModelReport, String> {
    download_model_spec_with_progress(models_dir, spec, |_| {}).await
}

/// Stream (or resume) a `ModelSpec` GGUF artifact with progress callbacks and SHA-256 verification.
pub async fn download_model_spec_with_progress<F>(
    models_dir: &Path,
    spec: &ModelSpec,
    mut on_progress: F,
) -> Result<DownloadModelReport, String>
where
    F: FnMut(DownloadProgress),
{
    fs::create_dir_all(models_dir)
        .map_err(|e| format!("failed to create models directory: {e}"))?;
    let dest = models_dir.join(&spec.gguf_filename);

    if let Ok(meta) = fs::metadata(&dest)
        && meta.is_file()
        && meta.len() == spec.size_bytes
        && let Ok(existing_sha) = compute_file_sha256(&dest)
        && existing_sha.eq_ignore_ascii_case(&spec.sha256)
    {
        on_progress(DownloadProgress {
            model_id: spec.id.clone(),
            bytes_downloaded: meta.len(),
            total_bytes: spec.size_bytes.max(meta.len()),
            percent: 100,
        });
        return Ok(DownloadModelReport {
            id: spec.id.clone(),
            gguf_path: dest.display().to_string(),
            bytes_downloaded: meta.len(),
            sha256: existing_sha,
            verified: true,
            already_present: true,
        });
    }

    let part_path = models_dir.join(format!("{}.part", spec.gguf_filename));
    let existing_part_len = fs::metadata(&part_path)
        .ok()
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .unwrap_or(0);
    let resume_from =
        if existing_part_len > 0 && (spec.size_bytes == 0 || existing_part_len < spec.size_bytes) {
            existing_part_len
        } else {
            0
        };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3600))
        .build()
        .map_err(|e| format!("failed to construct HTTP client: {e}"))?;

    let mut req = client.get(&spec.gguf_url);
    if resume_from > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={resume_from}-"));
    }

    let mut response = req
        .send()
        .await
        .map_err(|e| format!("model download failed: {e}"))?;

    // If a stale or oversized .part triggers 416 Range Not Satisfiable, discard it and restart cleanly.
    if resume_from > 0 && response.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        let _ = fs::remove_file(&part_path);
        response = client
            .get(&spec.gguf_url)
            .send()
            .await
            .map_err(|e| format!("model download failed: {e}"))?;
    }

    let resumed = resume_from > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    if !resumed && !response.status().is_success() {
        return Err(format!(
            "model download returned HTTP {}",
            response.status()
        ));
    }

    let expected_total = if spec.size_bytes > 0 {
        spec.size_bytes
    } else {
        response
            .content_length()
            .map(|len| if resumed { resume_from + len } else { len })
            .unwrap_or(0)
    };

    let mut hasher = Sha256::new();
    let mut total_bytes: u64 = 0;

    let mut file = if resumed {
        hash_existing_file(&part_path, &mut hasher)
            .map_err(|e| format!("failed to hash partial model file: {e}"))?;
        total_bytes = resume_from;
        OpenOptions::new()
            .append(true)
            .open(&part_path)
            .map_err(|e| format!("failed to open partial model file for resume: {e}"))?
    } else {
        File::create(&part_path).map_err(|e| format!("failed to create temp model file: {e}"))?
    };

    let initial_pct = compute_percent(total_bytes, expected_total);
    on_progress(DownloadProgress {
        model_id: spec.id.clone(),
        bytes_downloaded: total_bytes,
        total_bytes: expected_total,
        percent: initial_pct,
    });
    let mut last_reported_percent = Some(initial_pct);

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("stream error downloading model: {e}"))?
    {
        if let Err(e) = file.write_all(&chunk) {
            return Err(format!("failed to write model chunk: {e}"));
        }
        hasher.update(&chunk);
        total_bytes += chunk.len() as u64;

        let pct = compute_percent(total_bytes, expected_total);
        if last_reported_percent != Some(pct) {
            last_reported_percent = Some(pct);
            on_progress(DownloadProgress {
                model_id: spec.id.clone(),
                bytes_downloaded: total_bytes,
                total_bytes: expected_total.max(total_bytes),
                percent: pct,
            });
        }
    }

    if let Err(e) = file.flush() {
        return Err(format!("failed to flush model file: {e}"));
    }
    drop(file);

    if spec.size_bytes > 0 && total_bytes != spec.size_bytes {
        let _ = fs::remove_file(&part_path);
        return Err(format!(
            "downloaded size mismatch for {}: expected {} bytes, got {} bytes",
            spec.id, spec.size_bytes, total_bytes
        ));
    }

    let actual_sha = encode_hex(&hasher.finalize());
    if !spec.sha256.is_empty() && !actual_sha.eq_ignore_ascii_case(&spec.sha256) {
        let _ = fs::remove_file(&part_path);
        return Err(format!(
            "SHA-256 verification failed for {}: expected {}, got {}",
            spec.id, spec.sha256, actual_sha
        ));
    }

    fs::rename(&part_path, &dest).map_err(|e| {
        let _ = fs::remove_file(&part_path);
        format!("failed to move verified model into place: {e}")
    })?;

    on_progress(DownloadProgress {
        model_id: spec.id.clone(),
        bytes_downloaded: total_bytes,
        total_bytes: expected_total.max(total_bytes),
        percent: 100,
    });

    Ok(DownloadModelReport {
        id: spec.id.clone(),
        gguf_path: dest.display().to_string(),
        bytes_downloaded: total_bytes,
        sha256: actual_sha,
        verified: true,
        already_present: false,
    })
}

fn compute_percent(downloaded: u64, total: u64) -> u8 {
    if total == 0 {
        return 0;
    }
    ((downloaded.saturating_mul(100)) / total).min(100) as u8
}

fn hash_existing_file(path: &Path, hasher: &mut Sha256) -> std::io::Result<()> {
    let mut file = File::open(path)?;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(())
}

fn compute_file_sha256(path: &Path) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(encode_hex(&hasher.finalize()))
}

fn encode_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(&mut out, "{b:02x}");
    }
    out
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
