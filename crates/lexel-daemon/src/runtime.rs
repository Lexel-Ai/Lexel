use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use lexel_core::{ChatMessage, RuntimeKind, UnifiedSettings};
use serde::{Deserialize, Serialize};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::models_fs::{ollama_has_tag, resolve_gguf_path};

/// Live summary of the inference runtime state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    pub active_backend: String,
    pub model_loaded: bool,
    pub loaded_model: Option<String>,
    pub llama_server_available: bool,
    pub ollama_binary_available: bool,
    pub ollama_running: bool,
    pub ollama_models: Vec<String>,
    pub last_error: Option<String>,
}

struct ManagedLlama {
    child: Child,
    port: u16,
    gguf_path: PathBuf,
}

struct InnerRuntime {
    llama: Option<ManagedLlama>,
    active_backend: Option<String>,
    loaded_model: Option<String>,
    last_used: Option<Instant>,
    last_error: Option<String>,
}

/// Manages lazy model loading, Ollama/llama-server process lifecycle, and idle unloading.
pub struct RuntimeManager {
    data_dir: PathBuf,
    models_dir: PathBuf,
    http: reqwest::Client,
    inner: Mutex<InnerRuntime>,
}

impl RuntimeManager {
    pub fn new(data_dir: PathBuf, models_dir: PathBuf) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(90))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            data_dir,
            models_dir,
            http,
            inner: Mutex::new(InnerRuntime {
                llama: None,
                active_backend: None,
                loaded_model: None,
                last_used: None,
                last_error: None,
            }),
        }
    }

    pub fn models_dir(&self) -> &Path {
        &self.models_dir
    }

    /// Inspect available local backends and warm model state without loading weights.
    pub async fn snapshot(&self, settings: &UnifiedSettings) -> RuntimeSnapshot {
        let llama_server_available = self.find_llama_server().is_some();
        let ollama_binary_available = find_in_path("ollama").is_some();
        let (ollama_running, ollama_models) = self.probe_ollama(&settings.ollama_endpoint).await;

        let inner = self.inner.lock().await;
        let model_loaded = inner.loaded_model.is_some();
        let active_backend = inner
            .active_backend
            .clone()
            .unwrap_or_else(|| "idle".to_owned());

        RuntimeSnapshot {
            active_backend,
            model_loaded,
            loaded_model: inner.loaded_model.clone(),
            llama_server_available,
            ollama_binary_available,
            ollama_running,
            ollama_models,
            last_error: inner.last_error.clone(),
        }
    }

    /// Ensure the configured model is ready on the active backend (called on AI toggle ON or rewrite).
    pub async fn activate(&self, settings: &UnifiedSettings) -> Result<String, String> {
        if !settings.ai_enabled {
            self.unload(settings).await;
            return Err("Local AI is turned off in settings.".to_owned());
        }

        let target_model = settings.effective_model_name();
        let gguf_path = resolve_gguf_path(&self.models_dir, settings);
        let llama_bin = self.find_llama_server();
        let ollama_bin = find_in_path("ollama");

        let chosen = match settings.runtime {
            RuntimeKind::LlamaServer => RuntimeKind::LlamaServer,
            RuntimeKind::Ollama => RuntimeKind::Ollama,
            RuntimeKind::OpenAiCompat => RuntimeKind::OpenAiCompat,
            RuntimeKind::Auto => {
                if llama_bin.is_some() && gguf_path.is_some() {
                    RuntimeKind::LlamaServer
                } else if ollama_bin.is_some()
                    || self.probe_ollama(&settings.ollama_endpoint).await.0
                {
                    RuntimeKind::Ollama
                } else if self
                    .probe_openai_compat(&settings.open_ai_compat_endpoint)
                    .await
                {
                    RuntimeKind::OpenAiCompat
                } else if gguf_path.is_some() {
                    return Err(
                        "GGUF model files are installed, but neither llama-server nor Ollama was found. Install Ollama or place llama-server in ~/.local/share/lexel/bin/."
                            .to_owned(),
                    );
                } else {
                    return Err(
                        "No local models found yet. Run `make setup` (scripts/setup-models.sh) to download Lexel 0.5B and 1.5B."
                            .to_owned(),
                    );
                }
            }
        };

        let mut inner = self.inner.lock().await;
        match chosen {
            RuntimeKind::LlamaServer => {
                let bin = llama_bin.ok_or_else(|| {
                    "llama-server binary not found in PATH or ~/.local/share/lexel/bin/.".to_owned()
                })?;
                let gguf = gguf_path.ok_or_else(|| {
                    "Selected GGUF file is missing. Run `make setup` to download both models."
                        .to_owned()
                })?;

                let already_running = inner.llama.as_ref().is_some_and(|l| l.gguf_path == gguf);
                if !already_running {
                    self.stop_llama_locked(&mut inner).await;
                    let port = allocate_loopback_port()?;
                    let threads = default_cpu_threads();
                    info!(model = %target_model, port, threads, "starting managed llama-server");

                    // Native Messaging uses stdin/stdout for JSON IPC, so child stdio must stay null.
                    let child = Command::new(&bin)
                        .arg("--model")
                        .arg(&gguf)
                        .arg("--host")
                        .arg("127.0.0.1")
                        .arg("--port")
                        .arg(port.to_string())
                        .arg("--ctx-size")
                        .arg("2048")
                        .arg("--threads")
                        .arg(threads.to_string())
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .kill_on_drop(true)
                        .spawn()
                        .map_err(|e| format!("failed to launch llama-server: {e}"))?;

                    inner.llama = Some(ManagedLlama {
                        child,
                        port,
                        gguf_path: gguf,
                    });

                    let health_url = format!("http://127.0.0.1:{port}/health");
                    if let Err(err) =
                        wait_for_http_ok(&self.http, &health_url, Duration::from_secs(15)).await
                    {
                        self.stop_llama_locked(&mut inner).await;
                        inner.last_error = Some(err.clone());
                        return Err(err);
                    }
                }

                inner.active_backend = Some("llama_server".to_owned());
                inner.loaded_model = Some(target_model.clone());
                inner.last_used = Some(Instant::now());
                inner.last_error = None;
                Ok("llama_server".to_owned())
            }
            RuntimeKind::Ollama => {
                self.stop_llama_locked(&mut inner).await;
                let endpoint = validate_loopback(&settings.ollama_endpoint)?;
                let (mut running, mut models) = self.probe_ollama(&endpoint).await;

                if !running && let Some(bin) = ollama_bin.as_ref() {
                    info!("starting local ollama server on demand");
                    let _ = Command::new(bin)
                        .arg("serve")
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn();
                    let tags_url = format!("{endpoint}/api/tags");
                    let _ = wait_for_http_ok(&self.http, &tags_url, Duration::from_secs(8)).await;
                    let probed = self.probe_ollama(&endpoint).await;
                    running = probed.0;
                    models = probed.1;
                }

                if !running {
                    let msg = format!(
                        "Cannot reach Ollama at {endpoint}. Start Ollama (`ollama serve`) or switch runtime."
                    );
                    inner.last_error = Some(msg.clone());
                    return Err(msg);
                }

                if !ollama_has_tag(&target_model, &models)
                    && let (Some(bin), Some(gguf)) = (ollama_bin.as_ref(), gguf_path.as_ref())
                {
                    self.register_gguf_with_ollama(bin, &target_model, gguf)
                        .await?;
                    let (_, refreshed) = self.probe_ollama(&endpoint).await;
                    models = refreshed;
                }

                if !ollama_has_tag(&target_model, &models) {
                    let msg = format!(
                        "Ollama is running, but `{target_model}` is not installed. Run `make setup` or `ollama pull {target_model}`."
                    );
                    inner.last_error = Some(msg.clone());
                    return Err(msg);
                }

                inner.active_backend = Some("ollama".to_owned());
                inner.loaded_model = Some(target_model);
                inner.last_used = Some(Instant::now());
                inner.last_error = None;
                Ok("ollama".to_owned())
            }
            RuntimeKind::OpenAiCompat => {
                self.stop_llama_locked(&mut inner).await;
                let endpoint = validate_loopback(&settings.open_ai_compat_endpoint)?;
                if !self.probe_openai_compat(&endpoint).await {
                    let msg = format!("Cannot reach local OpenAI-compatible server at {endpoint}.");
                    inner.last_error = Some(msg.clone());
                    return Err(msg);
                }
                inner.active_backend = Some("openai_compat".to_owned());
                inner.loaded_model = Some(target_model);
                inner.last_used = Some(Instant::now());
                inner.last_error = None;
                Ok("openai_compat".to_owned())
            }
            RuntimeKind::Auto => unreachable!(),
        }
    }

    /// Generate a rewrite response from the active local backend.
    pub async fn generate_chat(
        &self,
        settings: &UnifiedSettings,
        messages: &[ChatMessage],
    ) -> Result<(String, String), String> {
        let backend = self.activate(settings).await?;
        let model = settings.effective_model_name();

        let output = match backend.as_str() {
            "llama_server" => {
                let port = {
                    let inner = self.inner.lock().await;
                    inner
                        .llama
                        .as_ref()
                        .map(|l| l.port)
                        .ok_or_else(|| "llama-server exited unexpectedly".to_owned())?
                };
                let url = format!("http://127.0.0.1:{port}/v1/chat/completions");
                self.post_openai_chat(&url, &model, messages, settings)
                    .await?
            }
            "ollama" => {
                let base = validate_loopback(&settings.ollama_endpoint)?;
                let keep_alive = if settings.keep_warm {
                    "-1".to_owned()
                } else {
                    format!("{}s", settings.idle_unload_secs.max(30))
                };
                let res = self
                    .http
                    .post(format!("{base}/api/chat"))
                    .json(&serde_json::json!({
                        "model": model,
                        "messages": messages,
                        "stream": false,
                        "keep_alive": keep_alive,
                        "options": {
                            "temperature": settings.temperature,
                            "num_predict": settings.max_tokens,
                            "num_ctx": 2048
                        }
                    }))
                    .send()
                    .await
                    .map_err(|e| format!("Ollama request failed: {e}"))?;

                if !res.status().is_success() {
                    let status = res.status();
                    let body = res.text().await.unwrap_or_default();
                    let snippet: String = body.chars().take(160).collect();
                    return Err(format!("Ollama error ({status}): {snippet}"));
                }
                let payload: serde_json::Value = res
                    .json()
                    .await
                    .map_err(|e| format!("Invalid Ollama response: {e}"))?;
                payload
                    .pointer("/message/content")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned)
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| "Local model returned an empty response.".to_owned())?
            }
            _ => {
                let base = validate_loopback(&settings.open_ai_compat_endpoint)?;
                let url = format!("{base}/v1/chat/completions");
                self.post_openai_chat(&url, &model, messages, settings)
                    .await?
            }
        };

        let mut inner = self.inner.lock().await;
        inner.last_used = Some(Instant::now());
        Ok((output, model))
    }

    /// Unload active model weights from RAM immediately.
    pub async fn unload(&self, settings: &UnifiedSettings) {
        let prev_backend;
        let prev_model;
        {
            let mut inner = self.inner.lock().await;
            self.stop_llama_locked(&mut inner).await;
            prev_backend = inner.active_backend.take();
            prev_model = inner.loaded_model.take();
            inner.last_used = None;
        }

        if prev_backend.as_deref() == Some("ollama")
            && let (Some(model), Ok(base)) =
                (prev_model, validate_loopback(&settings.ollama_endpoint))
        {
            let _ = self
                .http
                .post(format!("{base}/api/generate"))
                .json(&serde_json::json!({
                    "model": model,
                    "keep_alive": 0
                }))
                .send()
                .await;
        }
    }

    /// Unload model if idle timeout elapsed and `keep_warm` is disabled.
    pub async fn maybe_idle_unload(&self, settings: &UnifiedSettings) {
        if settings.keep_warm || settings.idle_unload_secs == 0 {
            return;
        }
        let should_unload = {
            let inner = self.inner.lock().await;
            match inner.last_used {
                Some(t) if inner.loaded_model.is_some() => {
                    t.elapsed() >= Duration::from_secs(settings.idle_unload_secs)
                }
                _ => false,
            }
        };
        if should_unload {
            info!(
                ttl_secs = settings.idle_unload_secs,
                "idle TTL reached; unloading local model"
            );
            self.unload(settings).await;
        }
    }

    async fn post_openai_chat(
        &self,
        url: &str,
        model: &str,
        messages: &[ChatMessage],
        settings: &UnifiedSettings,
    ) -> Result<String, String> {
        let res = self
            .http
            .post(url)
            .json(&serde_json::json!({
                "model": model,
                "messages": messages,
                "temperature": settings.temperature,
                "max_tokens": settings.max_tokens,
                "stream": false
            }))
            .send()
            .await
            .map_err(|e| format!("Local AI request failed: {e}"))?;

        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            let snippet: String = body.chars().take(160).collect();
            return Err(format!("Local AI server error ({status}): {snippet}"));
        }

        let payload: serde_json::Value = res
            .json()
            .await
            .map_err(|e| format!("Invalid local AI JSON response: {e}"))?;
        payload
            .pointer("/choices/0/message/content")
            .and_then(|v| v.as_str())
            .map(str::to_owned)
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| "Local model returned an empty response.".to_owned())
    }

    async fn register_gguf_with_ollama(
        &self,
        ollama_bin: &Path,
        tag: &str,
        gguf_path: &Path,
    ) -> Result<(), String> {
        let modelfile_dir = self.data_dir.join("tmp");
        let _ = std::fs::create_dir_all(&modelfile_dir);
        let modelfile_path = modelfile_dir.join(format!("Modelfile.{}", uuid::Uuid::new_v4()));
        let content = format!("FROM {}\nPARAMETER num_ctx 2048\n", gguf_path.display());
        std::fs::write(&modelfile_path, content)
            .map_err(|e| format!("Failed to write temporary Ollama Modelfile: {e}"))?;

        info!(tag = %tag, "registering local GGUF into Ollama without re-downloading");
        let status = Command::new(ollama_bin)
            .arg("create")
            .arg(tag)
            .arg("-f")
            .arg(&modelfile_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;

        let _ = std::fs::remove_file(&modelfile_path);
        match status {
            Ok(s) if s.success() => Ok(()),
            Ok(s) => Err(format!("`ollama create {tag}` exited with {s}")),
            Err(e) => Err(format!("Failed to invoke `ollama create`: {e}")),
        }
    }

    async fn probe_ollama(&self, raw_endpoint: &str) -> (bool, Vec<String>) {
        let Ok(base) = validate_loopback(raw_endpoint) else {
            return (false, Vec::new());
        };
        let Ok(res) = self
            .http
            .get(format!("{base}/api/tags"))
            .timeout(Duration::from_millis(1200))
            .send()
            .await
        else {
            return (false, Vec::new());
        };
        if !res.status().is_success() {
            return (false, Vec::new());
        }
        let Ok(val) = res.json::<serde_json::Value>().await else {
            return (true, Vec::new());
        };
        let models = val
            .get("models")
            .and_then(|m| m.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| item.get("name").and_then(|n| n.as_str()).map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        (true, models)
    }

    async fn probe_openai_compat(&self, raw_endpoint: &str) -> bool {
        let Ok(base) = validate_loopback(raw_endpoint) else {
            return false;
        };
        self.http
            .get(format!("{base}/v1/models"))
            .timeout(Duration::from_millis(1200))
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
    }

    async fn stop_llama_locked(&self, inner: &mut InnerRuntime) {
        if let Some(mut managed) = inner.llama.take() {
            if let Err(err) = managed.child.kill().await {
                warn!("failed to kill managed llama-server: {err}");
            }
            let _ = managed.child.wait().await;
        }
    }

    fn find_llama_server(&self) -> Option<PathBuf> {
        let bin_name = if cfg!(windows) {
            "llama-server.exe"
        } else {
            "llama-server"
        };
        let bundled = self.data_dir.join("bin").join(bin_name);
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
                ".unsloth/llama.cpp",
                ".unsloth/llama.cpp/bin",
                ".unsloth/llama.cpp/build/bin",
                ".unsloth/studio/llama.cpp",
                ".unsloth/studio/llama.cpp/bin",
                ".unsloth/studio/llama.cpp/build/bin",
            ] {
                let candidate = home.join(rel).join(bin_name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
        find_in_path(bin_name)
    }
}

fn validate_loopback(raw: &str) -> Result<String, String> {
    let parsed = url::Url::parse(raw.trim()).map_err(|_| "Invalid AI endpoint URL.".to_owned())?;
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    if host != "127.0.0.1" && host != "localhost" && host != "[::1]" {
        return Err(format!(
            "Privacy block: host `{host}` is not local. Only 127.0.0.1 or localhost is allowed."
        ));
    }
    Ok(parsed.to_string().trim_end_matches('/').to_owned())
}

fn find_in_path(binary: &str) -> Option<PathBuf> {
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(binary);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    if let Some(home) = dirs::home_dir() {
        let local_candidate = home.join(".local/bin").join(binary);
        if local_candidate.is_file() {
            return Some(local_candidate);
        }
    }
    for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        let candidate = Path::new(dir).join(binary);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn allocate_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to bind ephemeral loopback port: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to read bound port: {e}"))?
        .port();
    Ok(port)
}

fn default_cpu_threads() -> usize {
    let avail = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    avail.saturating_sub(1).clamp(1, 6)
}

async fn wait_for_http_ok(
    client: &reqwest::Client,
    url: &str,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if client
            .get(url)
            .timeout(Duration::from_millis(800))
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
        {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Err(format!("Timed out waiting for local server at {url}"))
}
