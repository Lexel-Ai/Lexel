use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use lexel_core::UnifiedSettings;
use serde::{Deserialize, Serialize};
use tokio::process::Command;

const MAX_AUDIO_BYTES: usize = 25 * 1024 * 1024;
const WHISPER_TIMEOUT_SECS: u64 = 60;

/// Health/availability status of local whisper.cpp transcription support.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WhisperDoctorStatus {
    pub binary_available: bool,
    pub binary_path: Option<String>,
    pub model_available: bool,
    pub model_path: Option<String>,
}

/// Inspect whether `whisper-cli` and a local GGML whisper model are present on disk.
pub fn inspect_whisper(
    data_dir: &Path,
    models_dir: &Path,
    settings: &UnifiedSettings,
) -> WhisperDoctorStatus {
    let bin = find_whisper_binary(data_dir);
    let model = find_whisper_model(models_dir, settings);
    WhisperDoctorStatus {
        binary_available: bin.is_some(),
        binary_path: bin.map(|p| p.display().to_string()),
        model_available: model.is_some(),
        model_path: model.map(|p| p.display().to_string()),
    }
}

/// Locate a local `whisper-cli` (or `whisper-cpp`) binary without making network requests.
pub fn find_whisper_binary(data_dir: &Path) -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["whisper-cli.exe", "whisper-cpp.exe"]
    } else {
        &["whisper-cli", "whisper-cpp"]
    };

    for bin_name in names {
        let bundled = data_dir.join("bin").join(bin_name);
        if bundled.is_file() {
            return Some(bundled);
        }
        if let Ok(exe) = std::env::current_exe()
            && let Some(dir) = exe.parent()
        {
            let sibling = dir.join(bin_name);
            if sibling.is_file() {
                return Some(sibling);
            }
        }
        if let Some(home) = dirs::home_dir() {
            for rel in [
                ".local/bin",
                ".local/share/lexel/bin",
                ".unsloth/whisper.cpp",
                ".unsloth/whisper.cpp/build/bin",
            ] {
                let candidate = home.join(rel).join(bin_name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
        if let Some(path_var) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&path_var) {
                let candidate = dir.join(bin_name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
        for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
            let candidate = Path::new(dir).join(bin_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Locate a local GGML whisper model file (`.bin`) in user config or `<models_dir>/whisper/`.
pub fn find_whisper_model(models_dir: &Path, settings: &UnifiedSettings) -> Option<PathBuf> {
    let configured = settings.whisper_model_path.trim();
    if !configured.is_empty() {
        let explicit = PathBuf::from(configured);
        if explicit.is_file() {
            return Some(explicit);
        }
        let in_models = models_dir.join(configured);
        if in_models.is_file() {
            return Some(in_models);
        }
        let in_whisper = models_dir.join("whisper").join(configured);
        if in_whisper.is_file() {
            return Some(in_whisper);
        }
    }

    let preferred_names = [
        "ggml-base.en.bin",
        "ggml-small.en.bin",
        "ggml-tiny.en.bin",
        "ggml-base.bin",
        "ggml-small.bin",
        "ggml-tiny.bin",
    ];
    let search_dirs = [models_dir.join("whisper"), models_dir.to_path_buf()];

    for dir in &search_dirs {
        for name in &preferred_names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    for dir in &search_dirs {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file()
                    && let Some(fname) = path.file_name().and_then(|s| s.to_str())
                    && fname.starts_with("ggml-")
                    && fname.ends_with(".bin")
                {
                    return Some(path);
                }
            }
        }
    }

    None
}

struct TempAudioGuard(PathBuf);

impl Drop for TempAudioGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Transcribe raw audio bytes completely offline using local `whisper-cli`.
/// Temporary audio files are always cleaned up before returning.
pub async fn transcribe_audio(
    data_dir: &Path,
    models_dir: &Path,
    settings: &UnifiedSettings,
    audio_bytes: &[u8],
    audio_format: &str,
    language: &str,
) -> Result<(String, String), String> {
    if audio_bytes.is_empty() {
        return Err("Audio payload is empty.".to_owned());
    }
    if audio_bytes.len() > MAX_AUDIO_BYTES {
        return Err("Audio payload exceeds the 25 MB local transcription limit.".to_owned());
    }

    let bin = find_whisper_binary(data_dir).ok_or_else(|| {
        format!(
            "Offline voice transcription requires `whisper-cli` (from whisper.cpp). Install whisper-cli in PATH or place it in {}.",
            data_dir.join("bin").display()
        )
    })?;

    let model_path = find_whisper_model(models_dir, settings).ok_or_else(|| {
        format!(
            "No local Whisper GGML model found. Download `ggml-base.en.bin` (or `ggml-tiny.en.bin`) into {} or set `whisperModelPath` in Lexel Settings.",
            models_dir.join("whisper").display()
        )
    })?;

    let ext = match audio_format.trim().to_ascii_lowercase().as_str() {
        "" | "wav" | "audio/wav" | "audio/wave" | "audio/x-wav" => "wav",
        "ogg" | "audio/ogg" => "ogg",
        "mp3" | "audio/mpeg" => "mp3",
        "flac" | "audio/flac" => "flac",
        other => {
            return Err(format!(
                "Unsupported audio format `{other}`. Send 16 kHz mono WAV audio (`wav`)."
            ));
        }
    };

    let lang = sanitize_lang(language);
    let tmp_dir = data_dir.join("tmp");
    std::fs::create_dir_all(&tmp_dir)
        .map_err(|e| format!("Failed to create temp audio directory: {e}"))?;
    let tmp_path = tmp_dir.join(format!("lexel-audio-{}.{ext}", uuid::Uuid::new_v4()));
    std::fs::write(&tmp_path, audio_bytes)
        .map_err(|e| format!("Failed to write temporary audio buffer: {e}"))?;
    let _guard = TempAudioGuard(tmp_path.clone());

    let mut cmd = Command::new(&bin);
    cmd.arg("-m")
        .arg(&model_path)
        .arg("-f")
        .arg(&tmp_path)
        .arg("-l")
        .arg(&lang)
        .arg("--no-timestamps")
        .arg("-nt")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = tokio::time::timeout(Duration::from_secs(WHISPER_TIMEOUT_SECS), cmd.output())
        .await
        .map_err(|_| "Local whisper-cli transcription timed out after 60 seconds.".to_owned())?
        .map_err(|e| format!("Failed to launch whisper-cli: {e}"))?;

    if !output.status.success() {
        let stderr_str = String::from_utf8_lossy(&output.stderr);
        let snippet: String = stderr_str.trim().chars().take(200).collect();
        return Err(format!(
            "whisper-cli exited with {}: {}",
            output.status,
            if snippet.is_empty() {
                "check that the input is valid 16 kHz WAV audio"
            } else {
                &snippet
            }
        ));
    }

    let stdout_str = String::from_utf8_lossy(&output.stdout);
    let transcript = clean_whisper_stdout(&stdout_str);
    let model_name = model_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("whisper-ggml")
        .to_owned();

    Ok((transcript, model_name))
}

fn sanitize_lang(raw: &str) -> String {
    let cleaned: String = raw
        .trim()
        .chars()
        .filter(|c| c.is_ascii_alphabetic())
        .take(8)
        .collect();
    if cleaned.is_empty() {
        "en".to_owned()
    } else {
        cleaned.to_ascii_lowercase()
    }
}

fn clean_whisper_stdout(raw: &str) -> String {
    raw.lines()
        .map(str::trim)
        .filter(|line| {
            !line.is_empty()
                && !line.eq_ignore_ascii_case("[BLANK_AUDIO]")
                && !line.eq_ignore_ascii_case("(silence)")
        })
        .collect::<Vec<_>>()
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_whisper_blank_audio_and_whitespace() {
        let raw = "  [BLANK_AUDIO] \n  hello   world \n\n  we fixed pr 42  ";
        assert_eq!(clean_whisper_stdout(raw), "hello world we fixed pr 42");
    }

    #[test]
    fn missing_binary_returns_clear_actionable_error() {
        let tmp = std::env::temp_dir().join(format!("lexel-whisper-test-{}", uuid::Uuid::new_v4()));
        let settings = UnifiedSettings::default();
        let status = inspect_whisper(&tmp, &tmp, &settings);
        assert!(!status.model_available);
    }
}
