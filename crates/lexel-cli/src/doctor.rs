use std::fmt::Write as _;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use anyhow::Result;
use clap::Args;
use lexel_core::{HarperEngine, ModelManifest, SlopScanner, SurfaceCatalog, scan_secrets};
use lexel_db::{default_data_dir, default_models_dir, default_token_path};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const NATIVE_HOST_NAME: &str = "com.lexel.daemon";

#[derive(Args)]
pub struct DoctorArgs {
    /// Running lexel-daemon HTTP base URL
    #[arg(long, default_value = "http://127.0.0.1:42424")]
    pub endpoint: String,
    /// Run a short live Tier 1 generation via the daemon to measure tok/s
    #[arg(long)]
    pub bench: bool,
    /// Emit machine-readable JSON diagnostics
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeManifestStatus {
    pub browser: String,
    pub manifest_path: String,
    pub installed: bool,
    pub valid_json: bool,
    pub host_binary_exists: bool,
    pub allowed_origins: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelHashStatus {
    pub id: String,
    pub gguf_path: String,
    pub gguf_installed: bool,
    pub size_valid: bool,
    pub expected_sha256: String,
    pub actual_sha256: Option<String>,
    pub sha256_verified: bool,
    pub ollama_installed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StandaloneDoctorReport {
    pub ok: bool,
    pub source: String,
    pub daemon_reachable: bool,
    pub version: String,
    pub data_dir: String,
    pub models_dir: String,
    pub runtime_details: serde_json::Value,
    pub native_messaging: Vec<NativeManifestStatus>,
    pub models: Vec<ModelHashStatus>,
    pub tier0_latency_ms: f64,
    pub measured_tok_per_sec: Option<f64>,
}

pub async fn run_doctor(args: DoctorArgs) -> Result<()> {
    let base_url = args.endpoint.trim_end_matches('/');
    let token = fs::read_to_string(default_token_path())
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());

    // Prefer the daemon's /v1/doctor endpoint whenever lexel-daemon is running.
    if let Some(ref tok) = token
        && let Ok(client) = reqwest::Client::builder()
            .connect_timeout(Duration::from_millis(400))
            .timeout(Duration::from_secs(if args.bench { 30 } else { 8 }))
            .build()
    {
        let url = if args.bench {
            format!("{base_url}/v1/doctor?bench=true")
        } else {
            format!("{base_url}/v1/doctor")
        };
        if let Ok(resp) = client.get(&url).bearer_auth(tok).send().await
            && resp.status().is_success()
            && let Ok(mut payload) = resp.json::<serde_json::Value>().await
        {
            if let Some(obj) = payload.as_object_mut() {
                obj.insert("source".to_owned(), serde_json::json!("daemon"));
                obj.insert("daemonReachable".to_owned(), serde_json::json!(true));
            }
            if args.json {
                println!("{}", serde_json::to_string_pretty(&payload)?);
            } else {
                print_doctor_report(&payload);
            }
            return Ok(());
        }
    }

    // Fallback: standalone local inspection when daemon is stopped.
    let report = collect_standalone_doctor().await;
    let payload = serde_json::to_value(&report)?;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&payload)?);
    } else {
        print_doctor_report(&payload);
    }
    Ok(())
}

fn measure_tier0_latency_ms() -> f64 {
    let sample = "We should delve into the deployment pipeline — latency dropped from 42ms to 9ms across `lexel-core` endpoints.";
    let started = Instant::now();
    if let Ok(mut harper) = HarperEngine::new(0, &Default::default(), &[], "") {
        let _ = harper.check_text(sample);
    }
    if let Ok(scanner) = SlopScanner::load_embedded() {
        let _ = scanner.scan(sample, false);
    }
    if let Ok(catalog) = SurfaceCatalog::load_embedded() {
        let _ = catalog.validate(sample, "web_github_pr");
    }
    let _ = scan_secrets(sample);
    ((started.elapsed().as_secs_f64() * 1000.0) * 100.0).round() / 100.0
}

fn find_binary_on_path(name: &str, data_dir: &Path) -> Option<PathBuf> {
    let exe_name = if cfg!(windows) && !name.ends_with(".exe") {
        format!("{name}.exe")
    } else {
        name.to_owned()
    };
    let local_bin = data_dir.join("bin").join(&exe_name);
    if local_bin.is_file() {
        return Some(local_bin);
    }
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let cand = dir.join(&exe_name);
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

fn detect_hardware_acceleration() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return "metal";
    }
    if Command::new("nvidia-smi")
        .arg("--query-gpu=name")
        .arg("--format=csv,noheader")
        .output()
        .is_ok_and(|o| o.status.success() && !o.stdout.is_empty())
    {
        return "cuda";
    }
    if Command::new("vulkaninfo")
        .arg("--summary")
        .output()
        .is_ok_and(|o| o.status.success())
    {
        return "vulkan";
    }
    "cpu"
}

fn probe_llama_server_details(data_dir: &Path) -> (Option<String>, Option<String>, bool) {
    let Some(path) = find_binary_on_path("llama-server", data_dir) else {
        return (None, None, false);
    };
    let version = Command::new(&path)
        .arg("--version")
        .output()
        .ok()
        .map(|o| {
            let text = String::from_utf8_lossy(&o.stdout);
            let err = String::from_utf8_lossy(&o.stderr);
            let combined = if text.trim().is_empty() { err } else { text };
            combined.lines().next().unwrap_or("").trim().to_owned()
        })
        .filter(|s| !s.is_empty());

    let help_text = Command::new(&path)
        .arg("--help")
        .output()
        .ok()
        .map(|o| {
            format!(
                "{}\n{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            )
        })
        .unwrap_or_default();
    let spec_supported = help_text.contains("--spec-type")
        || help_text.contains("--lookup")
        || help_text.contains("ngram-simple");
    (Some(path.display().to_string()), version, spec_supported)
}

async fn probe_ollama_models() -> (bool, Vec<String>) {
    let Ok(client) = reqwest::Client::builder()
        .connect_timeout(Duration::from_millis(250))
        .timeout(Duration::from_secs(2))
        .build()
    else {
        return (false, Vec::new());
    };
    let Ok(resp) = client.get("http://127.0.0.1:11434/api/tags").send().await else {
        return (false, Vec::new());
    };
    if !resp.status().is_success() {
        return (false, Vec::new());
    }
    let Ok(val) = resp.json::<serde_json::Value>().await else {
        return (true, Vec::new());
    };
    let names = val
        .get("models")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("name").and_then(|n| n.as_str()).map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    (true, names)
}

fn native_manifest_targets(data_dir: &Path) -> Vec<(&'static str, PathBuf)> {
    #[cfg(target_os = "windows")]
    {
        let manifest_dir = data_dir.join("native-messaging");
        let chrome_path = manifest_dir.join(format!("{NATIVE_HOST_NAME}.chrome.json"));
        let firefox_path = manifest_dir.join(format!("{NATIVE_HOST_NAME}.firefox.json"));
        vec![
            ("Google Chrome", chrome_path.clone()),
            ("Chromium", chrome_path.clone()),
            ("Brave", chrome_path.clone()),
            ("Microsoft Edge", chrome_path),
            ("Firefox", firefox_path),
        ]
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = data_dir;
        let Some(home) = dirs::home_dir() else {
            return Vec::new();
        };
        let filename = format!("{NATIVE_HOST_NAME}.json");
        #[cfg(target_os = "macos")]
        {
            let app_sup = home.join("Library/Application Support");
            vec![
                (
                    "Google Chrome",
                    app_sup
                        .join("Google/Chrome/NativeMessagingHosts")
                        .join(&filename),
                ),
                (
                    "Chromium",
                    app_sup
                        .join("Chromium/NativeMessagingHosts")
                        .join(&filename),
                ),
                (
                    "Brave",
                    app_sup
                        .join("BraveSoftware/Brave-Browser/NativeMessagingHosts")
                        .join(&filename),
                ),
                (
                    "Microsoft Edge",
                    app_sup
                        .join("Microsoft Edge/NativeMessagingHosts")
                        .join(&filename),
                ),
                (
                    "Firefox",
                    app_sup.join("Mozilla/NativeMessagingHosts").join(&filename),
                ),
            ]
        }
        #[cfg(not(target_os = "macos"))]
        {
            let cfg = dirs::config_dir().unwrap_or_else(|| home.join(".config"));
            vec![
                (
                    "Google Chrome",
                    cfg.join("google-chrome/NativeMessagingHosts")
                        .join(&filename),
                ),
                (
                    "Chromium",
                    cfg.join("chromium/NativeMessagingHosts").join(&filename),
                ),
                (
                    "Brave",
                    cfg.join("BraveSoftware/Brave-Browser/NativeMessagingHosts")
                        .join(&filename),
                ),
                (
                    "Microsoft Edge",
                    cfg.join("microsoft-edge/NativeMessagingHosts")
                        .join(&filename),
                ),
                (
                    "Firefox",
                    home.join(".mozilla/native-messaging-hosts").join(&filename),
                ),
            ]
        }
    }
}

fn inspect_native_manifests(data_dir: &Path) -> Vec<NativeManifestStatus> {
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
                if let Some(arr) = val
                    .get("allowed_origins")
                    .or_else(|| val.get("allowed_extensions"))
                    .and_then(|v| v.as_array())
                {
                    allowed_origins = arr
                        .iter()
                        .filter_map(|item| item.as_str().map(str::to_owned))
                        .collect();
                }
            }

            NativeManifestStatus {
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
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for b in digest {
        let _ = write!(&mut hex, "{b:02x}");
    }
    Ok(hex)
}

fn inspect_models(models_dir: &Path, ollama_models: &[String]) -> Vec<ModelHashStatus> {
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
            let sha256_verified = actual_sha256.as_deref().is_some_and(|actual| {
                !spec.sha256.is_empty() && actual.eq_ignore_ascii_case(&spec.sha256)
            });
            let ollama_installed = ollama_models.iter().any(|m| {
                m.eq_ignore_ascii_case(&spec.ollama_tag) || m.eq_ignore_ascii_case(&spec.id)
            });

            ModelHashStatus {
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

async fn collect_standalone_doctor() -> StandaloneDoctorReport {
    let data_dir = default_data_dir();
    let models_dir = default_models_dir();
    let tier0_latency_ms = measure_tier0_latency_ms();
    let (llama_path, llama_version, spec_supported) = probe_llama_server_details(&data_dir);
    let ollama_path = find_binary_on_path("ollama", &data_dir).map(|p| p.display().to_string());
    let (ollama_running, ollama_models) = probe_ollama_models().await;
    let accel = detect_hardware_acceleration();
    let native_messaging = inspect_native_manifests(&data_dir);
    let models = inspect_models(&models_dir, &ollama_models);

    StandaloneDoctorReport {
        ok: true,
        source: "standalone".to_owned(),
        daemon_reachable: false,
        version: env!("CARGO_PKG_VERSION").to_owned(),
        data_dir: data_dir.display().to_string(),
        models_dir: models_dir.display().to_string(),
        runtime_details: serde_json::json!({
            "llamaServerPath": llama_path,
            "llamaServerVersion": llama_version,
            "speculativeLookupSupported": spec_supported,
            "ollamaBinaryPath": ollama_path,
            "ollamaRunning": ollama_running,
            "hardwareAcceleration": accel,
        }),
        native_messaging,
        models,
        tier0_latency_ms,
        measured_tok_per_sec: None,
    }
}

fn print_doctor_report(v: &serde_json::Value) {
    let source = v.get("source").and_then(|s| s.as_str()).unwrap_or("daemon");
    let reachable = v
        .get("daemonReachable")
        .and_then(|b| b.as_bool())
        .unwrap_or(source == "daemon");
    let version = v
        .get("version")
        .and_then(|s| s.as_str())
        .unwrap_or(env!("CARGO_PKG_VERSION"));
    let tier0 = v
        .get("tier0LatencyMs")
        .and_then(|n| n.as_f64())
        .unwrap_or(0.0);
    let tok_s = v.get("measuredTokPerSec").and_then(|n| n.as_f64());

    println!("Lexel Doctor (v{version}, source={source})");
    println!(
        "  Daemon:            {}",
        if reachable {
            "running (127.0.0.1)"
        } else {
            "offline (standalone check)"
        }
    );
    if let Some(rd) = v.get("runtimeDetails") {
        let accel = rd
            .get("hardwareAcceleration")
            .and_then(|s| s.as_str())
            .unwrap_or("unknown");
        let llama = rd
            .get("llamaServerPath")
            .and_then(|s| s.as_str())
            .unwrap_or("not found");
        let spec = rd
            .get("speculativeLookupSupported")
            .and_then(|b| b.as_bool())
            .unwrap_or(false);
        println!("  Hardware accel:    {accel}");
        println!("  llama-server:      {llama} (speculative lookup: {spec})");
    }
    println!("  Tier 0 latency:    {tier0:.2} ms");
    match tok_s {
        Some(tps) => println!("  Tier 1 speed:      {tps:.1} tok/s"),
        None => println!(
            "  Tier 1 speed:      not measured yet (start lexel-daemon and run `lexel doctor --bench`)"
        ),
    }

    if let Some(arr) = v.get("nativeMessaging").and_then(|x| x.as_array()) {
        println!("\nNative Messaging manifests:");
        for item in arr {
            let browser = item.get("browser").and_then(|s| s.as_str()).unwrap_or("?");
            let installed = item
                .get("installed")
                .and_then(|b| b.as_bool())
                .unwrap_or(false);
            let valid = item
                .get("validJson")
                .and_then(|b| b.as_bool())
                .unwrap_or(false);
            let host_ok = item
                .get("hostBinaryExists")
                .and_then(|b| b.as_bool())
                .unwrap_or(false);
            let status = if installed && valid && host_ok {
                "ok"
            } else if installed {
                "broken (check JSON or host binary)"
            } else {
                "missing"
            };
            println!("  {:<16} {}", browser, status);
        }
    }

    if let Some(arr) = v.get("models").and_then(|x| x.as_array()) {
        println!("\nLocal GGUF Models:");
        for item in arr {
            let id = item.get("id").and_then(|s| s.as_str()).unwrap_or("?");
            let installed = item
                .get("ggufInstalled")
                .and_then(|b| b.as_bool())
                .unwrap_or(false);
            let sha_ok = item
                .get("sha256Verified")
                .and_then(|b| b.as_bool())
                .unwrap_or(false);
            let ollama = item
                .get("ollamaInstalled")
                .and_then(|b| b.as_bool())
                .unwrap_or(false);
            let state = if installed && sha_ok {
                "installed (SHA-256 verified)"
            } else if installed {
                "installed (SHA-256 mismatch or unverified)"
            } else if ollama {
                "available via Ollama"
            } else {
                "not installed"
            };
            println!("  {:<16} {}", id, state);
        }
    }
}
