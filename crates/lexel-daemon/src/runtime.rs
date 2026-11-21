use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use lexel_core::{ChatMessage, MainModelTier, RuntimeKind, UnifiedSettings};
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

/// Detailed capability and acceleration metadata surfaced by `/v1/doctor`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDetails {
    pub llama_server_path: Option<String>,
    pub llama_server_version: Option<String>,
    pub speculative_lookup_supported: bool,
    pub speculative_lookup_flag: Option<String>,
    pub cache_prompt_supported: bool,
    pub hardware_acceleration: String,
}

/// Streaming token delta emitted during SSE / Native Messaging streaming rewrites.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamChunk {
    pub delta: String,
    pub accumulated: String,
}

/// Per-request generation tuning passed to the active local backend.
#[derive(Debug, Clone)]
pub struct GenerateOptions {
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
    pub stop: Vec<String>,
    pub timeout: Option<Duration>,
    pub prefer_fast_model: bool,
    pub apply_slop_logit_bias: bool,
}

impl Default for GenerateOptions {
    fn default() -> Self {
        Self {
            max_tokens: None,
            temperature: None,
            stop: Vec::new(),
            timeout: None,
            prefer_fast_model: false,
            apply_slop_logit_bias: true,
        }
    }
}

#[derive(Debug, Clone, Default)]
struct LlamaCapabilities {
    version: Option<String>,
    spec_type_ngram_simple: bool,
    spec_type_ngram_cache: bool,
    spec_ngram_simple_sizes: bool,
    cache_prompt_flag: bool,
    flash_attn_flag: bool,
    hardware_acceleration: String,
}

impl LlamaCapabilities {
    fn speculative_lookup_flag(&self) -> Option<String> {
        if self.spec_type_ngram_simple {
            Some("--spec-type ngram-simple".to_owned())
        } else if self.spec_type_ngram_cache {
            Some("--spec-type ngram-cache".to_owned())
        } else {
            None
        }
    }
}

struct ManagedLlama {
    child: Child,
    port: u16,
    gguf_path: PathBuf,
    logit_bias: serde_json::Map<String, serde_json::Value>,
}

struct InnerRuntime {
    llama: Option<ManagedLlama>,
    active_backend: Option<String>,
    loaded_model: Option<String>,
    last_used: Option<Instant>,
    last_error: Option<String>,
    last_tok_per_sec: Option<f64>,
    cached_caps: Option<(PathBuf, LlamaCapabilities)>,
}

/// Manages lazy model loading, Ollama/llama-server process lifecycle, speed flags, and idle unloading.
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
                last_tok_per_sec: None,
                cached_caps: None,
            }),
        }
    }

    pub fn models_dir(&self) -> &Path {
        &self.models_dir
    }

    /// Return the most recently measured generation throughput (tokens/sec), if any.
    pub async fn last_tok_per_sec(&self) -> Option<f64> {
        self.inner.lock().await.last_tok_per_sec
    }

    /// Inspect local `llama-server` binary flags, version, and hardware acceleration without loading weights.
    pub async fn runtime_details(&self) -> RuntimeDetails {
        let llama_bin = self.find_llama_server();
        let Some(bin) = llama_bin else {
            return RuntimeDetails {
                llama_server_path: None,
                llama_server_version: None,
                speculative_lookup_supported: false,
                speculative_lookup_flag: None,
                cache_prompt_supported: false,
                hardware_acceleration: detect_host_acceleration(None),
            };
        };

        let caps = self.probe_llama_capabilities(&bin).await;
        RuntimeDetails {
            llama_server_path: Some(bin.display().to_string()),
            llama_server_version: caps.version.clone(),
            speculative_lookup_supported: caps.speculative_lookup_flag().is_some(),
            speculative_lookup_flag: caps.speculative_lookup_flag(),
            cache_prompt_supported: caps.cache_prompt_flag,
            hardware_acceleration: caps.hardware_acceleration,
        }
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

        let llama_caps = if chosen == RuntimeKind::LlamaServer
            && let Some(bin) = llama_bin.as_ref()
        {
            Some(self.probe_llama_capabilities(bin).await)
        } else {
            None
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
                    let caps = llama_caps.unwrap_or_default();

                    let mut cmd = Command::new(&bin);
                    cmd.arg("--model")
                        .arg(&gguf)
                        .arg("--host")
                        .arg("127.0.0.1")
                        .arg("--port")
                        .arg(port.to_string())
                        .arg("--ctx-size")
                        .arg("2048")
                        .arg("--threads")
                        .arg(threads.to_string());

                    if caps.cache_prompt_flag {
                        cmd.arg("--cache-prompt");
                    }
                    if caps.flash_attn_flag {
                        cmd.arg("--flash-attn").arg("auto");
                    }
                    if caps.spec_type_ngram_simple {
                        cmd.arg("--spec-type").arg("ngram-simple");
                        if caps.spec_ngram_simple_sizes {
                            cmd.arg("--spec-ngram-simple-size-n")
                                .arg("4")
                                .arg("--spec-ngram-simple-size-m")
                                .arg("32");
                        }
                    } else if caps.spec_type_ngram_cache {
                        cmd.arg("--spec-type").arg("ngram-cache");
                    }

                    info!(
                        model = %target_model,
                        port,
                        threads,
                        spec_lookup = ?caps.speculative_lookup_flag(),
                        cache_prompt = caps.cache_prompt_flag,
                        "starting managed llama-server"
                    );

                    // Native Messaging uses stdin/stdout for JSON IPC, so child stdio must stay null.
                    let child = cmd
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
                        logit_bias: serde_json::Map::new(),
                    });

                    let health_url = format!("http://127.0.0.1:{port}/health");
                    if let Err(err) =
                        wait_for_http_ok(&self.http, &health_url, Duration::from_secs(15)).await
                    {
                        self.stop_llama_locked(&mut inner).await;
                        inner.last_error = Some(err.clone());
                        return Err(err);
                    }

                    let bias = self.build_slop_logit_bias(port).await;
                    if let Some(managed) = inner.llama.as_mut() {
                        managed.logit_bias = bias;
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

    /// Generate a rewrite response from the active local backend with default options.
    pub async fn generate_chat(
        &self,
        settings: &UnifiedSettings,
        messages: &[ChatMessage],
    ) -> Result<(String, String), String> {
        self.generate_chat_with_options(settings, messages, GenerateOptions::default())
            .await
    }

    /// Generate a chat completion using explicit per-request options (timeout, max_tokens, logit_bias, etc.).
    pub async fn generate_chat_with_options(
        &self,
        settings: &UnifiedSettings,
        messages: &[ChatMessage],
        options: GenerateOptions,
    ) -> Result<(String, String), String> {
        let effective_settings = self
            .resolve_effective_settings(settings, options.prefer_fast_model)
            .await;
        let backend = self.activate(&effective_settings).await?;
        let model = effective_settings.effective_model_name();
        let started = Instant::now();

        let (output, measured_tps) = match backend.as_str() {
            "llama_server" => {
                let (port, logit_bias) = {
                    let inner = self.inner.lock().await;
                    let managed = inner
                        .llama
                        .as_ref()
                        .ok_or_else(|| "llama-server exited unexpectedly".to_owned())?;
                    let bias = if options.apply_slop_logit_bias && !managed.logit_bias.is_empty() {
                        Some(managed.logit_bias.clone())
                    } else {
                        None
                    };
                    (managed.port, bias)
                };
                let url = format!("http://127.0.0.1:{port}/v1/chat/completions");
                self.post_openai_chat(
                    &url,
                    &model,
                    messages,
                    &effective_settings,
                    &options,
                    logit_bias,
                    true,
                )
                .await?
            }
            "ollama" => {
                self.post_ollama_chat(&model, messages, &effective_settings, &options)
                    .await?
            }
            _ => {
                let base = validate_loopback(&effective_settings.open_ai_compat_endpoint)?;
                let url = format!("{base}/v1/chat/completions");
                self.post_openai_chat(
                    &url,
                    &model,
                    messages,
                    &effective_settings,
                    &options,
                    None,
                    true,
                )
                .await?
            }
        };

        let elapsed_secs = started.elapsed().as_secs_f64();
        let fallback_tps = estimate_fallback_tps(&output, elapsed_secs);

        let mut inner = self.inner.lock().await;
        inner.last_used = Some(Instant::now());
        if let Some(tps) = measured_tps.or(fallback_tps) {
            inner.last_tok_per_sec = Some(round2(tps));
        }
        Ok((output, model))
    }

    /// Stream tokens from the active local backend, calling `on_chunk` for each delta and returning
    /// the full generated text and model identifier when finished.
    pub async fn generate_chat_stream<F>(
        &self,
        settings: &UnifiedSettings,
        messages: &[ChatMessage],
        options: GenerateOptions,
        mut on_chunk: F,
    ) -> Result<(String, String), String>
    where
        F: FnMut(StreamChunk) + Send,
    {
        let effective_settings = self
            .resolve_effective_settings(settings, options.prefer_fast_model)
            .await;
        let backend = self.activate(&effective_settings).await?;
        let model = effective_settings.effective_model_name();
        let started = Instant::now();

        let (output, measured_tps) = match backend.as_str() {
            "llama_server" => {
                let (port, logit_bias) = {
                    let inner = self.inner.lock().await;
                    let managed = inner
                        .llama
                        .as_ref()
                        .ok_or_else(|| "llama-server exited unexpectedly".to_owned())?;
                    let bias = if options.apply_slop_logit_bias && !managed.logit_bias.is_empty() {
                        Some(managed.logit_bias.clone())
                    } else {
                        None
                    };
                    (managed.port, bias)
                };
                let url = format!("http://127.0.0.1:{port}/v1/chat/completions");
                self.stream_openai_chat(
                    &url,
                    &model,
                    messages,
                    &effective_settings,
                    &options,
                    logit_bias,
                    &mut on_chunk,
                )
                .await?
            }
            "ollama" => {
                self.stream_ollama_chat(
                    &model,
                    messages,
                    &effective_settings,
                    &options,
                    &mut on_chunk,
                )
                .await?
            }
            _ => {
                let base = validate_loopback(&effective_settings.open_ai_compat_endpoint)?;
                let url = format!("{base}/v1/chat/completions");
                self.stream_openai_chat(
                    &url,
                    &model,
                    messages,
                    &effective_settings,
                    &options,
                    None,
                    &mut on_chunk,
                )
                .await?
            }
        };

        let elapsed_secs = started.elapsed().as_secs_f64();
        let fallback_tps = estimate_fallback_tps(&output, elapsed_secs);

        let mut inner = self.inner.lock().await;
        inner.last_used = Some(Instant::now());
        if let Some(tps) = measured_tps.or(fallback_tps) {
            inner.last_tok_per_sec = Some(round2(tps));
        }
        Ok((output, model))
    }

    /// Run a short local 16-token benchmark when explicitly requested by `/v1/doctor?bench=true`.
    pub async fn quick_bench_tok_per_sec(&self, settings: &UnifiedSettings) -> Option<f64> {
        if !settings.ai_enabled {
            return None;
        }
        let messages = vec![
            ChatMessage {
                role: "system".to_owned(),
                content: "Output one short sentence with no preamble.".to_owned(),
            },
            ChatMessage {
                role: "user".to_owned(),
                content: "Rewrite: This is an test of local writing speed.".to_owned(),
            },
        ];
        let opts = GenerateOptions {
            max_tokens: Some(16),
            temperature: Some(0.1),
            timeout: Some(Duration::from_secs(12)),
            ..GenerateOptions::default()
        };
        if self
            .generate_chat_with_options(settings, &messages, opts)
            .await
            .is_ok()
        {
            self.last_tok_per_sec().await
        } else {
            None
        }
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

    /// For lightweight ghost-text completions, prefer `lexel-0.5b` if no model is loaded yet and 0.5B
    /// is installed locally; otherwise reuse the already-loaded model to avoid swapping weights.
    async fn resolve_effective_settings(
        &self,
        settings: &UnifiedSettings,
        prefer_fast_model: bool,
    ) -> UnifiedSettings {
        if !prefer_fast_model {
            return settings.clone();
        }
        let already_loaded = self.inner.lock().await.loaded_model.is_some();
        if already_loaded {
            return settings.clone();
        }
        let mut lite = settings.clone();
        lite.main_model_tier = MainModelTier::Lexel05B;
        if resolve_gguf_path(&self.models_dir, &lite).is_some() {
            return lite;
        }
        let (ollama_up, models) = self.probe_ollama(&settings.ollama_endpoint).await;
        if ollama_up && ollama_has_tag("qwen2.5:0.5b", &models) {
            return lite;
        }
        settings.clone()
    }

    async fn probe_llama_capabilities(&self, bin: &Path) -> LlamaCapabilities {
        {
            let inner = self.inner.lock().await;
            if let Some((cached_path, caps)) = &inner.cached_caps
                && cached_path == bin
            {
                return caps.clone();
            }
        }

        let help_text = run_probe_cmd(bin, "--help").await.unwrap_or_default();
        let version_raw = run_probe_cmd(bin, "--version").await;
        let version = version_raw.as_deref().and_then(parse_llama_version);

        let spec_type_line = help_text.contains("--spec-type");
        let spec_type_ngram_simple = spec_type_line && help_text.contains("ngram-simple");
        let spec_type_ngram_cache = spec_type_line && help_text.contains("ngram-cache");
        let spec_ngram_simple_sizes = help_text.contains("--spec-ngram-simple-size-n")
            && help_text.contains("--spec-ngram-simple-size-m");
        let cache_prompt_flag = help_text.contains("--cache-prompt");
        let flash_attn_flag = help_text.contains("--flash-attn");
        let hardware_acceleration = detect_host_acceleration(version_raw.as_deref());

        let caps = LlamaCapabilities {
            version,
            spec_type_ngram_simple,
            spec_type_ngram_cache,
            spec_ngram_simple_sizes,
            cache_prompt_flag,
            flash_attn_flag,
            hardware_acceleration,
        };

        let mut inner = self.inner.lock().await;
        inner.cached_caps = Some((bin.to_path_buf(), caps.clone()));
        caps
    }

    /// Ask the running `llama-server` `/tokenize` endpoint for exact single-token IDs of em/en
    /// dashes and top AI slop buzzwords so we can ban them at the sampler (`logit_bias`) without
    /// ever accidentally banning multi-token subword pieces.
    async fn build_slop_logit_bias(&self, port: u16) -> serde_json::Map<String, serde_json::Value> {
        const PROBE_TERMS: &[&str] = &[
            "—",
            " —",
            "— ",
            "–",
            " –",
            "delve",
            " delve",
            "Delve",
            "tapestry",
            " tapestry",
            "seamless",
            " seamless",
            "leverage",
            " leverage",
            "pivotal",
            " pivotal",
            "realm",
            " realm",
            "unleash",
            " unleash",
        ];

        let url = format!("http://127.0.0.1:{port}/tokenize");
        let mut bias = serde_json::Map::new();

        for term in PROBE_TERMS {
            let Ok(resp) = self
                .http
                .post(&url)
                .timeout(Duration::from_millis(800))
                .json(&serde_json::json!({
                    "content": term,
                    "add_special": false,
                    "parse_special": false
                }))
                .send()
                .await
            else {
                // If /tokenize is unreachable or unsupported, abort probing cleanly.
                break;
            };
            if !resp.status().is_success() {
                break;
            }
            let Ok(val) = resp.json::<serde_json::Value>().await else {
                continue;
            };
            if let Some(tokens) = val.get("tokens").and_then(|v| v.as_array())
                && tokens.len() == 1
                && let Some(id) = tokens[0].as_i64()
            {
                bias.insert(id.to_string(), serde_json::json!(-100.0));
            }
        }

        if !bias.is_empty() {
            info!(
                banned_tokens = bias.len(),
                "configured sampler logit_bias for dashes and top slop tokens"
            );
        }
        bias
    }

    #[allow(clippy::too_many_arguments)]
    async fn post_openai_chat(
        &self,
        url: &str,
        model: &str,
        messages: &[ChatMessage],
        settings: &UnifiedSettings,
        options: &GenerateOptions,
        logit_bias: Option<serde_json::Map<String, serde_json::Value>>,
        cache_prompt: bool,
    ) -> Result<(String, Option<f64>), String> {
        let mut body = serde_json::json!({
            "model": model,
            "messages": messages,
            "temperature": options.temperature.unwrap_or(settings.temperature),
            "max_tokens": options.max_tokens.unwrap_or(settings.max_tokens),
            "stream": false,
            "cache_prompt": cache_prompt
        });
        if let Some(obj) = body.as_object_mut() {
            if !options.stop.is_empty() {
                obj.insert("stop".to_owned(), serde_json::json!(options.stop));
            }
            if let Some(bias) = logit_bias
                && !bias.is_empty()
            {
                obj.insert("logit_bias".to_owned(), serde_json::Value::Object(bias));
            }
        }

        let mut req = self.http.post(url).json(&body);
        if let Some(t) = options.timeout {
            req = req.timeout(t);
        }

        let res = req
            .send()
            .await
            .map_err(|e| format!("Local AI request failed: {e}"))?;

        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            let snippet: String = text.chars().take(160).collect();
            return Err(format!("Local AI server error ({status}): {snippet}"));
        }

        let payload: serde_json::Value = res
            .json()
            .await
            .map_err(|e| format!("Invalid local AI JSON response: {e}"))?;

        let tps = payload
            .pointer("/timings/predicted_per_second")
            .and_then(|v| v.as_f64())
            .filter(|v| v.is_finite() && *v > 0.0);

        let content = payload
            .pointer("/choices/0/message/content")
            .and_then(|v| v.as_str())
            .map(str::to_owned)
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| "Local model returned an empty response.".to_owned())?;

        Ok((content, tps))
    }

    #[allow(clippy::too_many_arguments)]
    async fn stream_openai_chat<F>(
        &self,
        url: &str,
        model: &str,
        messages: &[ChatMessage],
        settings: &UnifiedSettings,
        options: &GenerateOptions,
        logit_bias: Option<serde_json::Map<String, serde_json::Value>>,
        on_chunk: &mut F,
    ) -> Result<(String, Option<f64>), String>
    where
        F: FnMut(StreamChunk) + Send,
    {
        let mut body = serde_json::json!({
            "model": model,
            "messages": messages,
            "temperature": options.temperature.unwrap_or(settings.temperature),
            "max_tokens": options.max_tokens.unwrap_or(settings.max_tokens),
            "stream": true,
            "cache_prompt": true
        });
        if let Some(obj) = body.as_object_mut() {
            if !options.stop.is_empty() {
                obj.insert("stop".to_owned(), serde_json::json!(options.stop));
            }
            if let Some(bias) = logit_bias
                && !bias.is_empty()
            {
                obj.insert("logit_bias".to_owned(), serde_json::Value::Object(bias));
            }
        }

        let mut req = self.http.post(url).json(&body);
        if let Some(t) = options.timeout {
            req = req.timeout(t);
        }

        let mut res = req
            .send()
            .await
            .map_err(|e| format!("Local AI streaming request failed: {e}"))?;

        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            let snippet: String = text.chars().take(160).collect();
            return Err(format!("Local AI server error ({status}): {snippet}"));
        }

        let mut pending = String::new();
        let mut accumulated = String::new();
        let mut measured_tps: Option<f64> = None;

        while let Some(bytes) = res
            .chunk()
            .await
            .map_err(|e| format!("Local AI stream read error: {e}"))?
        {
            pending.push_str(&String::from_utf8_lossy(&bytes));
            while let Some(pos) = pending.find('\n') {
                let line = pending[..pos].trim().to_owned();
                pending.drain(..=pos);
                let Some(data) = line.strip_prefix("data:") else {
                    continue;
                };
                let data = data.trim();
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(tps) = val
                        .pointer("/timings/predicted_per_second")
                        .and_then(|v| v.as_f64())
                        .filter(|v| v.is_finite() && *v > 0.0)
                    {
                        measured_tps = Some(tps);
                    }
                    if let Some(delta) = val
                        .pointer("/choices/0/delta/content")
                        .and_then(|v| v.as_str())
                        && !delta.is_empty()
                    {
                        accumulated.push_str(delta);
                        on_chunk(StreamChunk {
                            delta: delta.to_owned(),
                            accumulated: accumulated.clone(),
                        });
                    }
                }
            }
        }

        if accumulated.trim().is_empty() {
            return Err("Local model returned an empty streaming response.".to_owned());
        }
        Ok((accumulated, measured_tps))
    }

    async fn post_ollama_chat(
        &self,
        model: &str,
        messages: &[ChatMessage],
        settings: &UnifiedSettings,
        options: &GenerateOptions,
    ) -> Result<(String, Option<f64>), String> {
        let base = validate_loopback(&settings.ollama_endpoint)?;
        let keep_alive = if settings.keep_warm {
            "-1".to_owned()
        } else {
            format!("{}s", settings.idle_unload_secs.max(30))
        };

        let mut opt_map = serde_json::json!({
            "temperature": options.temperature.unwrap_or(settings.temperature),
            "num_predict": options.max_tokens.unwrap_or(settings.max_tokens),
            "num_ctx": 2048,
            "num_thread": default_cpu_threads(),
            "repeat_penalty": 1.05
        });
        if !options.stop.is_empty()
            && let Some(obj) = opt_map.as_object_mut()
        {
            obj.insert("stop".to_owned(), serde_json::json!(options.stop));
        }

        let mut req = self
            .http
            .post(format!("{base}/api/chat"))
            .json(&serde_json::json!({
                "model": model,
                "messages": messages,
                "stream": false,
                "keep_alive": keep_alive,
                "options": opt_map
            }));
        if let Some(t) = options.timeout {
            req = req.timeout(t);
        }

        let res = req
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

        let tps = parse_ollama_tps(&payload);
        let content = payload
            .pointer("/message/content")
            .and_then(|v| v.as_str())
            .map(str::to_owned)
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| "Local model returned an empty response.".to_owned())?;

        Ok((content, tps))
    }

    async fn stream_ollama_chat<F>(
        &self,
        model: &str,
        messages: &[ChatMessage],
        settings: &UnifiedSettings,
        options: &GenerateOptions,
        on_chunk: &mut F,
    ) -> Result<(String, Option<f64>), String>
    where
        F: FnMut(StreamChunk) + Send,
    {
        let base = validate_loopback(&settings.ollama_endpoint)?;
        let keep_alive = if settings.keep_warm {
            "-1".to_owned()
        } else {
            format!("{}s", settings.idle_unload_secs.max(30))
        };

        let mut opt_map = serde_json::json!({
            "temperature": options.temperature.unwrap_or(settings.temperature),
            "num_predict": options.max_tokens.unwrap_or(settings.max_tokens),
            "num_ctx": 2048,
            "num_thread": default_cpu_threads(),
            "repeat_penalty": 1.05
        });
        if !options.stop.is_empty()
            && let Some(obj) = opt_map.as_object_mut()
        {
            obj.insert("stop".to_owned(), serde_json::json!(options.stop));
        }

        let mut req = self
            .http
            .post(format!("{base}/api/chat"))
            .json(&serde_json::json!({
                "model": model,
                "messages": messages,
                "stream": true,
                "keep_alive": keep_alive,
                "options": opt_map
            }));
        if let Some(t) = options.timeout {
            req = req.timeout(t);
        }

        let mut res = req
            .send()
            .await
            .map_err(|e| format!("Ollama streaming request failed: {e}"))?;

        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            let snippet: String = body.chars().take(160).collect();
            return Err(format!("Ollama error ({status}): {snippet}"));
        }

        let mut pending = String::new();
        let mut accumulated = String::new();
        let mut measured_tps: Option<f64> = None;

        while let Some(bytes) = res
            .chunk()
            .await
            .map_err(|e| format!("Ollama stream read error: {e}"))?
        {
            pending.push_str(&String::from_utf8_lossy(&bytes));
            while let Some(pos) = pending.find('\n') {
                let line = pending[..pos].trim().to_owned();
                pending.drain(..=pos);
                if line.is_empty() {
                    continue;
                }
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
                    if let Some(delta) = val.pointer("/message/content").and_then(|v| v.as_str())
                        && !delta.is_empty()
                    {
                        accumulated.push_str(delta);
                        on_chunk(StreamChunk {
                            delta: delta.to_owned(),
                            accumulated: accumulated.clone(),
                        });
                    }
                    if let Some(tps) = parse_ollama_tps(&val) {
                        measured_tps = Some(tps);
                    }
                }
            }
        }

        if accumulated.trim().is_empty() {
            return Err("Local model returned an empty streaming response.".to_owned());
        }
        Ok((accumulated, measured_tps))
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

    pub fn find_llama_server(&self) -> Option<PathBuf> {
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

async fn run_probe_cmd(bin: &Path, arg: &str) -> Option<String> {
    let mut cmd = Command::new(bin);
    cmd.arg(arg)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = tokio::time::timeout(Duration::from_secs(3), cmd.output())
        .await
        .ok()?
        .ok()?;
    let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
    if !output.stderr.is_empty() {
        combined.push('\n');
        combined.push_str(&String::from_utf8_lossy(&output.stderr));
    }
    Some(combined)
}

fn parse_llama_version(raw: &str) -> Option<String> {
    for line in raw.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("version:") {
            return Some(rest.trim().to_owned());
        }
    }
    raw.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_owned)
}

fn detect_host_acceleration(version_output: Option<&str>) -> String {
    if let Some(text) = version_output {
        let lower = text.to_ascii_lowercase();
        if lower.contains("cuda") || lower.contains("cublas") {
            return "cuda".to_owned();
        }
        if lower.contains("metal") {
            return "metal".to_owned();
        }
        if lower.contains("vulkan") {
            return "vulkan".to_owned();
        }
        if lower.contains("rocm") || lower.contains("hipblas") {
            return "rocm".to_owned();
        }
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return "metal".to_owned();
    }
    #[cfg(target_os = "linux")]
    {
        if Path::new("/dev/nvidia0").exists() {
            return "cuda-capable".to_owned();
        }
        if let Ok(cpuinfo) = std::fs::read_to_string("/proc/cpuinfo") {
            if cpuinfo.contains("avx512") {
                return "cpu (avx512)".to_owned();
            }
            if cpuinfo.contains("avx2") {
                return "cpu (avx2)".to_owned();
            }
        }
    }
    "cpu".to_owned()
}

fn parse_ollama_tps(payload: &serde_json::Value) -> Option<f64> {
    let count = payload.get("eval_count")?.as_f64()?;
    let duration_ns = payload.get("eval_duration")?.as_f64()?;
    if count > 0.0 && duration_ns > 0.0 {
        Some(count / (duration_ns / 1_000_000_000.0))
    } else {
        None
    }
}

fn estimate_fallback_tps(output: &str, elapsed_secs: f64) -> Option<f64> {
    if elapsed_secs <= 0.005 {
        return None;
    }
    let est_tokens = lexel_core::estimate_tokens(output) as f64;
    if est_tokens > 0.0 {
        Some(est_tokens / elapsed_secs)
    } else {
        None
    }
}

fn round2(val: f64) -> f64 {
    (val * 100.0).round() / 100.0
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
