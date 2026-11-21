use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::service::DaemonService;

pub const NATIVE_HOST_NAME: &str = "com.lexel.daemon";
pub const FIREFOX_EXT_ID: &str = "lexel@lexel.local";
const MAX_NATIVE_MSG_BYTES: usize = 1024 * 1024;

#[derive(Debug, Deserialize)]
struct NativeEnvelope {
    id: Option<serde_json::Value>,
    kind: String,
    #[serde(default)]
    payload: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct NativeResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<serde_json::Value>,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    done: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Read one 4-byte little-endian length-prefixed JSON frame from `reader`.
pub fn read_frame<R: Read>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut len_buf = [0u8; 4];
    match reader.read_exact(&mut len_buf) {
        Ok(()) => {}
        Err(err) if err.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(err) => return Err(err),
    }
    let len = u32::from_le_bytes(len_buf) as usize;
    if len == 0 || len > MAX_NATIVE_MSG_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Native messaging frame length out of bounds: {len}"),
        ));
    }
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf)?;
    Ok(Some(buf))
}

/// Write one 4-byte little-endian length-prefixed JSON frame to `writer`.
pub fn write_frame<W: Write>(writer: &mut W, payload: &[u8]) -> io::Result<()> {
    let len = u32::try_from(payload.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "frame too large"))?;
    writer.write_all(&len.to_le_bytes())?;
    writer.write_all(payload)?;
    writer.flush()
}

fn safe_path_segment(raw: &str) -> Option<&str> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains(['/', '\\', '?', '#', '%'])
    {
        return None;
    }
    Some(trimmed)
}

/// Forward runtime-stateful and mutating RPC commands to a running Desktop/daemon loopback server
/// so the browser extension shares one loaded AI model in RAM and triggers live UI updates in Desktop.
pub async fn forward_rpc_to_loopback(
    http_port: u16,
    token: &str,
    kind: &str,
    payload: &serde_json::Value,
) -> Option<Result<serde_json::Value, String>> {
    let (method, path, body_payload): (reqwest::Method, String, Option<serde_json::Value>) =
        match kind {
            "status" => (reqwest::Method::GET, "/v1/status".to_owned(), None),
            "doctor" => {
                let bench = payload
                    .get("bench")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let path = if bench {
                    "/v1/doctor?bench=true".to_owned()
                } else {
                    "/v1/doctor".to_owned()
                };
                (reqwest::Method::GET, path, None)
            }
            "toggleAi" => (
                reqwest::Method::POST,
                "/v1/ai/toggle".to_owned(),
                Some(payload.clone()),
            ),
            "setMainModel" => (
                reqwest::Method::POST,
                "/v1/ai/main-model".to_owned(),
                Some(payload.clone()),
            ),
            "unloadAi" => (reqwest::Method::POST, "/v1/ai/unload".to_owned(), None),
            "downloadModel" => (
                reqwest::Method::POST,
                "/v1/models/download".to_owned(),
                Some(payload.clone()),
            ),
            "deleteModel" => {
                let id = payload
                    .get("modelId")
                    .or_else(|| payload.get("model"))
                    .and_then(|v| v.as_str())
                    .and_then(safe_path_segment)?;
                (reqwest::Method::DELETE, format!("/v1/models/{id}"), None)
            }
            "rewrite" | "aiRewrite" => (
                reqwest::Method::POST,
                "/v1/rewrite".to_owned(),
                Some(payload.clone()),
            ),
            "complete" | "ghostComplete" => (
                reqwest::Method::POST,
                "/v1/complete".to_owned(),
                Some(payload.clone()),
            ),
            "scopeThreadContext" => (
                reqwest::Method::POST,
                "/v1/context/scope".to_owned(),
                Some(payload.clone()),
            ),
            "redactPreview" => (
                reqwest::Method::POST,
                "/v1/tier0/redact-preview".to_owned(),
                Some(payload.clone()),
            ),
            "listSnippets" => (reqwest::Method::GET, "/v1/snippets".to_owned(), None),
            "expandSnippet" => (
                reqwest::Method::POST,
                "/v1/snippets/expand".to_owned(),
                Some(payload.clone()),
            ),
            "transcribe" => (
                reqwest::Method::POST,
                "/v1/transcribe".to_owned(),
                Some(payload.clone()),
            ),
            "weeklyInsights" => {
                let days = payload.get("days").and_then(|v| v.as_u64()).unwrap_or(7);
                (
                    reqwest::Method::GET,
                    format!("/v1/analytics/insights?days={days}"),
                    None,
                )
            }
            "getCrutchWords" => (
                reqwest::Method::GET,
                "/v1/settings/crutch-words".to_owned(),
                None,
            ),
            "setCrutchWords" => (
                reqwest::Method::PUT,
                "/v1/settings/crutch-words".to_owned(),
                Some(payload.clone()),
            ),
            "toggleCrutchWord" => (
                reqwest::Method::POST,
                "/v1/settings/crutch-words/toggle".to_owned(),
                Some(payload.clone()),
            ),
            "importVoiceExamples" => (
                reqwest::Method::POST,
                "/v1/voice-examples/import".to_owned(),
                Some(payload.clone()),
            ),
            "voiceStyleStats" => (
                reqwest::Method::GET,
                "/v1/voice-examples/style-stats".to_owned(),
                None,
            ),
            "exportSimpo" => (
                reqwest::Method::GET,
                "/v1/voice-examples/export-simpo".to_owned(),
                None,
            ),
            "patchSettings" => {
                let patch = payload
                    .get("patch")
                    .cloned()
                    .unwrap_or_else(|| payload.clone());
                (
                    reqwest::Method::PATCH,
                    "/v1/settings".to_owned(),
                    Some(patch),
                )
            }
            "updateSettings" => {
                let settings = payload
                    .get("settings")
                    .cloned()
                    .unwrap_or_else(|| payload.clone());
                (
                    reqwest::Method::PUT,
                    "/v1/settings".to_owned(),
                    Some(settings),
                )
            }
            "createProfile" => (
                reqwest::Method::POST,
                "/v1/profiles".to_owned(),
                Some(payload.clone()),
            ),
            "switchProfile" => (
                reqwest::Method::POST,
                "/v1/profiles/switch".to_owned(),
                Some(payload.clone()),
            ),
            "renameProfile" => {
                let id = payload
                    .get("profileId")
                    .and_then(|v| v.as_str())
                    .and_then(safe_path_segment)?;
                (
                    reqwest::Method::PATCH,
                    format!("/v1/profiles/{id}"),
                    Some(payload.clone()),
                )
            }
            "deleteProfile" => {
                let id = payload
                    .get("profileId")
                    .and_then(|v| v.as_str())
                    .and_then(safe_path_segment)?;
                (reqwest::Method::DELETE, format!("/v1/profiles/{id}"), None)
            }
            "applyRulePreset" => (
                reqwest::Method::POST,
                "/v1/harper/apply-preset".to_owned(),
                Some(payload.clone()),
            ),
            "buildWeirpack" => (
                reqwest::Method::POST,
                "/v1/harper/weirpack/build".to_owned(),
                Some(payload.clone()),
            ),
            "validateWeirpack" => (
                reqwest::Method::POST,
                "/v1/harper/weirpack/validate".to_owned(),
                Some(payload.clone()),
            ),
            "saveVoiceExample" => {
                let ex = payload
                    .get("example")
                    .cloned()
                    .unwrap_or_else(|| payload.clone());
                (
                    reqwest::Method::POST,
                    "/v1/voice-examples".to_owned(),
                    Some(ex),
                )
            }
            "deleteVoiceExample" => {
                let id = payload
                    .get("id")
                    .and_then(|v| v.as_str())
                    .and_then(safe_path_segment)?;
                (
                    reqwest::Method::DELETE,
                    format!("/v1/voice-examples/{id}"),
                    None,
                )
            }
            "writingStats" => (reqwest::Method::GET, "/v1/analytics/stats".to_owned(), None),
            "listDrafts" => (reqwest::Method::GET, "/v1/drafts".to_owned(), None),
            "saveDraft" => {
                let draft = payload
                    .get("draft")
                    .cloned()
                    .unwrap_or_else(|| payload.clone());
                (reqwest::Method::POST, "/v1/drafts".to_owned(), Some(draft))
            }
            "deleteDraft" => {
                let id = payload
                    .get("id")
                    .and_then(|v| v.as_str())
                    .and_then(safe_path_segment)?;
                (reqwest::Method::DELETE, format!("/v1/drafts/{id}"), None)
            }
            "importBackup" => {
                let backup = payload
                    .get("backup")
                    .cloned()
                    .unwrap_or_else(|| payload.clone());
                (reqwest::Method::POST, "/v1/import".to_owned(), Some(backup))
            }
            "purgeAll" => (reqwest::Method::POST, "/v1/purge".to_owned(), None),
            _ => return None,
        };

    let timeout_secs = if kind == "downloadModel" { 3600 } else { 120 };
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_millis(250))
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .ok()?;

    let url = format!("http://127.0.0.1:{http_port}{path}");
    let mut req = client.request(method, &url).bearer_auth(token);
    if let Some(body) = body_payload {
        req = req.json(&body);
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(_) => return None,
    };

    let status = resp.status();
    let body: serde_json::Value = match resp.json().await {
        Ok(val) => val,
        Err(err) => return Some(Err(format!("invalid response from running daemon: {err}"))),
    };

    if status.is_success() {
        Some(Ok(body))
    } else {
        let msg = body
            .get("error")
            .and_then(|v| v.as_str())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("daemon returned HTTP {status}"));
        Some(Err(msg))
    }
}

/// Stream SSE frames from a running loopback daemon's `/v1/rewrite/stream` endpoint directly into
/// Native Messaging chunk frames on `writer`. Returns `None` if no loopback daemon is reachable.
pub async fn forward_rewrite_stream_to_loopback<W: Write>(
    http_port: u16,
    token: &str,
    id: &Option<serde_json::Value>,
    payload: &serde_json::Value,
    writer: &mut W,
) -> Option<io::Result<()>> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_millis(250))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .ok()?;

    let url = format!("http://127.0.0.1:{http_port}/v1/rewrite/stream");
    let mut resp = match client
        .post(&url)
        .bearer_auth(token)
        .json(payload)
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return None,
    };

    if !resp.status().is_success() {
        let err_msg = resp
            .text()
            .await
            .unwrap_or_else(|_| "daemon streaming request failed".to_owned());
        let frame = NativeResponse {
            id: id.clone(),
            ok: false,
            stream: Some(true),
            done: Some(true),
            data: None,
            error: Some(err_msg),
        };
        let encoded = match serde_json::to_vec(&frame) {
            Ok(b) => b,
            Err(e) => return Some(Err(io::Error::other(e))),
        };
        return Some(write_frame(writer, &encoded));
    }

    let mut pending = String::new();
    let mut current_event = String::new();
    let mut saw_terminal = false;

    while let Ok(Some(bytes)) = resp.chunk().await {
        pending.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(pos) = pending.find('\n') {
            let line = pending[..pos].trim_end_matches('\r').to_owned();
            pending.drain(..=pos);
            if line.is_empty() {
                current_event.clear();
                continue;
            }
            if let Some(ev) = line.strip_prefix("event:") {
                current_event = ev.trim().to_owned();
                continue;
            }
            let Some(data_raw) = line.strip_prefix("data:") else {
                continue;
            };
            let data_raw = data_raw.trim();
            let parsed = serde_json::from_str::<serde_json::Value>(data_raw).ok();

            let frame = match current_event.as_str() {
                "chunk" => NativeResponse {
                    id: id.clone(),
                    ok: true,
                    stream: Some(true),
                    done: Some(false),
                    data: parsed,
                    error: None,
                },
                "complete" => {
                    saw_terminal = true;
                    NativeResponse {
                        id: id.clone(),
                        ok: true,
                        stream: Some(true),
                        done: Some(true),
                        data: parsed,
                        error: None,
                    }
                }
                "error" => {
                    saw_terminal = true;
                    let msg = parsed
                        .as_ref()
                        .and_then(|v| v.get("error"))
                        .and_then(|v| v.as_str())
                        .map(str::to_owned)
                        .unwrap_or_else(|| data_raw.to_owned());
                    NativeResponse {
                        id: id.clone(),
                        ok: false,
                        stream: Some(true),
                        done: Some(true),
                        data: None,
                        error: Some(msg),
                    }
                }
                _ => continue,
            };

            let encoded = match serde_json::to_vec(&frame) {
                Ok(b) => b,
                Err(e) => return Some(Err(io::Error::other(e))),
            };
            if let Err(err) = write_frame(writer, &encoded) {
                return Some(Err(err));
            }
        }
    }

    if !saw_terminal {
        let frame = NativeResponse {
            id: id.clone(),
            ok: false,
            stream: Some(true),
            done: Some(true),
            data: None,
            error: Some("Streaming rewrite ended before completion.".to_owned()),
        };
        if let Ok(encoded) = serde_json::to_vec(&frame) {
            return Some(write_frame(writer, &encoded));
        }
    }
    Some(Ok(()))
}

/// Run the Chrome/Firefox Native Messaging stdio loop until stdin closes.
pub async fn run_stdio_loop(service: Arc<DaemonService>) -> io::Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = stdin.lock();
    let mut writer = stdout.lock();
    let token = service.token().ok();

    while let Some(bytes) = read_frame(&mut reader)? {
        let parsed = serde_json::from_slice::<NativeEnvelope>(&bytes);
        let env = match parsed {
            Ok(env) => env,
            Err(err) => {
                warn!("invalid native messaging JSON: {err}");
                let resp = NativeResponse {
                    id: None,
                    ok: false,
                    stream: None,
                    done: None,
                    data: None,
                    error: Some(format!("Invalid request JSON: {err}")),
                };
                let encoded = serde_json::to_vec(&resp).map_err(io::Error::other)?;
                write_frame(&mut writer, &encoded)?;
                continue;
            }
        };

        if env.kind == "rewriteStream" {
            if let Some(tok) = token.as_deref()
                && let Some(res) = forward_rewrite_stream_to_loopback(
                    service.http_port,
                    tok,
                    &env.id,
                    &env.payload,
                    &mut writer,
                )
                .await
            {
                res?;
                continue;
            }

            let req_res: Result<crate::service::RewriteRequest, _> =
                serde_json::from_value(env.payload);
            match req_res {
                Ok(req) => {
                    let id_clone = env.id.clone();
                    let (chunk_tx, mut chunk_rx) =
                        tokio::sync::mpsc::unbounded_channel::<crate::runtime::StreamChunk>();
                    let svc = Arc::clone(&service);
                    let mut task = tokio::spawn(async move {
                        svc.rewrite_stream(req, move |chunk| {
                            let _ = chunk_tx.send(chunk);
                        })
                        .await
                    });

                    let final_outcome = loop {
                        tokio::select! {
                            Some(chunk) = chunk_rx.recv() => {
                                let frame = NativeResponse {
                                    id: id_clone.clone(),
                                    ok: true,
                                    stream: Some(true),
                                    done: Some(false),
                                    data: serde_json::to_value(&chunk).ok(),
                                    error: None,
                                };
                                let encoded = serde_json::to_vec(&frame).map_err(io::Error::other)?;
                                write_frame(&mut writer, &encoded)?;
                            }
                            res = &mut task => {
                                // Drain any buffered chunks before writing the terminal frame.
                                while let Ok(chunk) = chunk_rx.try_recv() {
                                    let frame = NativeResponse {
                                        id: id_clone.clone(),
                                        ok: true,
                                        stream: Some(true),
                                        done: Some(false),
                                        data: serde_json::to_value(&chunk).ok(),
                                        error: None,
                                    };
                                    let encoded = serde_json::to_vec(&frame).map_err(io::Error::other)?;
                                    write_frame(&mut writer, &encoded)?;
                                }
                                break res;
                            }
                        }
                    };

                    let terminal = match final_outcome {
                        Ok(Ok(data)) => NativeResponse {
                            id: env.id,
                            ok: true,
                            stream: Some(true),
                            done: Some(true),
                            data: serde_json::to_value(data).ok(),
                            error: None,
                        },
                        Ok(Err(err)) => NativeResponse {
                            id: env.id,
                            ok: false,
                            stream: Some(true),
                            done: Some(true),
                            data: None,
                            error: Some(err.to_string()),
                        },
                        Err(join_err) => NativeResponse {
                            id: env.id,
                            ok: false,
                            stream: Some(true),
                            done: Some(true),
                            data: None,
                            error: Some(format!("Streaming task failed: {join_err}")),
                        },
                    };
                    let encoded = serde_json::to_vec(&terminal).map_err(io::Error::other)?;
                    write_frame(&mut writer, &encoded)?;
                }
                Err(err) => {
                    let terminal = NativeResponse {
                        id: env.id,
                        ok: false,
                        stream: Some(true),
                        done: Some(true),
                        data: None,
                        error: Some(format!("Invalid rewriteStream payload: {err}")),
                    };
                    let encoded = serde_json::to_vec(&terminal).map_err(io::Error::other)?;
                    write_frame(&mut writer, &encoded)?;
                }
            }
            continue;
        }

        let forwarded = if let Some(tok) = token.as_deref() {
            forward_rpc_to_loopback(service.http_port, tok, &env.kind, &env.payload).await
        } else {
            None
        };

        let outcome = match forwarded {
            Some(res) => res,
            None => service
                .dispatch_rpc(&env.kind, env.payload)
                .await
                .map_err(|err| err.to_string()),
        };

        let resp = match outcome {
            Ok(data) => NativeResponse {
                id: env.id,
                ok: true,
                stream: None,
                done: None,
                data: Some(data),
                error: None,
            },
            Err(error) => NativeResponse {
                id: env.id,
                ok: false,
                stream: None,
                done: None,
                data: None,
                error: Some(error),
            },
        };

        let encoded = serde_json::to_vec(&resp).map_err(io::Error::other)?;
        write_frame(&mut writer, &encoded)?;
    }

    service.shutdown().await;
    Ok(())
}

/// Locate the `lexel-daemon` binary (or current executable supporting `native-messaging`).
pub fn locate_daemon_binary(data_dir: &Path) -> Option<PathBuf> {
    let exe_name = if cfg!(windows) {
        "lexel-daemon.exe"
    } else {
        "lexel-daemon"
    };

    if let Ok(current) = std::env::current_exe()
        && let Some(dir) = current.parent()
    {
        let sibling = dir.join(exe_name);
        if sibling.is_file() {
            return Some(sibling);
        }
    }

    let local_bin = data_dir.join("bin").join(exe_name);
    if local_bin.is_file() {
        return Some(local_bin);
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for rel in ["../../target/release", "../../target/debug"] {
        let candidate = manifest_dir.join(rel).join(exe_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(exe_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    std::env::current_exe().ok().filter(|p| p.is_file())
}

/// Read existing `allowed_origins` from any installed Chromium Native Messaging manifest so new
/// extension IDs merge cleanly without dropping previously linked browsers.
fn read_existing_chrome_origins(data_dir: &Path) -> Vec<String> {
    let mut existing = Vec::new();
    for (_browser, path) in native_manifest_targets(data_dir) {
        if let Ok(raw) = fs::read_to_string(&path)
            && let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw)
            && let Some(arr) = val.get("allowed_origins").and_then(|v| v.as_array())
        {
            for item in arr {
                if let Some(s) = item.as_str()
                    && s.starts_with("chrome-extension://")
                    && !s.contains("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
                    && !existing.iter().any(|e| e == s)
                {
                    existing.push(s.to_owned());
                }
            }
        }
    }
    existing
}

/// Install Chrome/Chromium/Brave and Firefox Native Messaging host manifests.
pub fn install_native_hosts(
    daemon_bin: &Path,
    data_dir: &Path,
    chrome_ext_ids: &[String],
) -> io::Result<Vec<PathBuf>> {
    let host_exec = prepare_host_executable(daemon_bin, data_dir)?;
    let host_exec_str = host_exec.display().to_string();

    let mut chrome_origins = read_existing_chrome_origins(data_dir);
    for id in chrome_ext_ids {
        let clean = id.trim().trim_end_matches('/');
        if clean.is_empty() {
            continue;
        }
        let origin = if clean.starts_with("chrome-extension://") {
            format!("{clean}/")
        } else {
            format!("chrome-extension://{clean}/")
        };
        if !chrome_origins.contains(&origin) {
            chrome_origins.push(origin);
        }
    }
    if chrome_origins.is_empty() {
        chrome_origins.push("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/".to_owned());
    }

    let chrome_manifest = serde_json::json!({
        "name": NATIVE_HOST_NAME,
        "description": "Lexel Local AI & Unified Profile Daemon",
        "path": host_exec_str,
        "type": "stdio",
        "allowed_origins": chrome_origins,
    });

    let firefox_manifest = serde_json::json!({
        "name": NATIVE_HOST_NAME,
        "description": "Lexel Local AI & Unified Profile Daemon",
        "path": host_exec_str,
        "type": "stdio",
        "allowed_extensions": [FIREFOX_EXT_ID],
    });

    let mut written = Vec::new();

    #[cfg(target_os = "windows")]
    {
        let manifest_dir = data_dir.join("native-messaging");
        fs::create_dir_all(&manifest_dir)?;
        let chrome_path = manifest_dir.join(format!("{NATIVE_HOST_NAME}.chrome.json"));
        let firefox_path = manifest_dir.join(format!("{NATIVE_HOST_NAME}.firefox.json"));
        fs::write(
            &chrome_path,
            format!(
                "{}\n",
                serde_json::to_string_pretty(&chrome_manifest).map_err(io::Error::other)?
            ),
        )?;
        fs::write(
            &firefox_path,
            format!(
                "{}\n",
                serde_json::to_string_pretty(&firefox_manifest).map_err(io::Error::other)?
            ),
        )?;
        written.push(chrome_path.clone());
        written.push(firefox_path.clone());

        let chrome_str = chrome_path.display().to_string();
        let firefox_str = firefox_path.display().to_string();
        for key in [
            format!(r"HKCU\Software\Google\Chrome\NativeMessagingHosts\{NATIVE_HOST_NAME}"),
            format!(r"HKCU\Software\Chromium\NativeMessagingHosts\{NATIVE_HOST_NAME}"),
            format!(
                r"HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\{NATIVE_HOST_NAME}"
            ),
            format!(r"HKCU\Software\Microsoft\Edge\NativeMessagingHosts\{NATIVE_HOST_NAME}"),
        ] {
            register_windows_native_host(&key, &chrome_str)?;
        }
        register_windows_native_host(
            &format!(r"HKCU\Software\Mozilla\NativeMessagingHosts\{NATIVE_HOST_NAME}"),
            &firefox_str,
        )?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        for dir in chromium_manifest_dirs() {
            if let Some(path) = write_manifest(&dir, &chrome_manifest)? {
                written.push(path);
            }
        }
        for dir in firefox_manifest_dirs() {
            if let Some(path) = write_manifest(&dir, &firefox_manifest)? {
                written.push(path);
            }
        }
    }

    Ok(written)
}

/// Return the canonical `(browser_label, manifest_path)` list inspected for Native Messaging status.
pub fn native_manifest_targets(data_dir: &Path) -> Vec<(&'static str, PathBuf)> {
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

#[cfg(target_os = "windows")]
fn register_windows_native_host(reg_key: &str, manifest_path: &str) -> io::Result<()> {
    let status = std::process::Command::new("reg")
        .args([
            "add",
            reg_key,
            "/ve",
            "/t",
            "REG_SZ",
            "/d",
            manifest_path,
            "/f",
        ])
        .status()?;
    if !status.success() {
        return Err(io::Error::other(format!(
            "reg add failed for {reg_key} with status {status}"
        )));
    }
    Ok(())
}

fn prepare_host_executable(daemon_bin: &Path, data_dir: &Path) -> io::Result<PathBuf> {
    let abs_bin = fs::canonicalize(daemon_bin).unwrap_or_else(|_| daemon_bin.to_path_buf());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let bin_dir = data_dir.join("bin");
        fs::create_dir_all(&bin_dir)?;
        let wrapper = bin_dir.join("lexel-native-host.sh");
        let script = format!(
            "#!/usr/bin/env bash\nexec \"{}\" native-messaging \"$@\"\n",
            abs_bin.display()
        );
        fs::write(&wrapper, script)?;
        fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755))?;
        Ok(wrapper)
    }
    #[cfg(target_os = "windows")]
    {
        let bin_dir = data_dir.join("bin");
        fs::create_dir_all(&bin_dir)?;
        let wrapper = bin_dir.join("lexel-native-host.cmd");
        let script = format!(
            "@echo off\r\n\"{}\" native-messaging %*\r\n",
            abs_bin.display()
        );
        fs::write(&wrapper, script)?;
        Ok(wrapper)
    }
    #[cfg(not(any(unix, target_os = "windows")))]
    {
        let _ = data_dir;
        Ok(abs_bin)
    }
}

#[cfg(not(target_os = "windows"))]
fn write_manifest(dir: &Path, payload: &serde_json::Value) -> io::Result<Option<PathBuf>> {
    fs::create_dir_all(dir)?;
    let path = dir.join(format!("{NATIVE_HOST_NAME}.json"));
    let body = serde_json::to_string_pretty(payload).map_err(io::Error::other)?;
    fs::write(&path, format!("{body}\n"))?;
    Ok(Some(path))
}

#[cfg(not(target_os = "windows"))]
fn chromium_manifest_dirs() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    #[cfg(target_os = "macos")]
    {
        let app_sup = home.join("Library/Application Support");
        vec![
            app_sup.join("Google/Chrome/NativeMessagingHosts"),
            app_sup.join("Chromium/NativeMessagingHosts"),
            app_sup.join("BraveSoftware/Brave-Browser/NativeMessagingHosts"),
            app_sup.join("Microsoft Edge/NativeMessagingHosts"),
        ]
    }
    #[cfg(not(target_os = "macos"))]
    {
        let cfg = dirs::config_dir().unwrap_or_else(|| home.join(".config"));
        vec![
            cfg.join("google-chrome/NativeMessagingHosts"),
            cfg.join("chromium/NativeMessagingHosts"),
            cfg.join("BraveSoftware/Brave-Browser/NativeMessagingHosts"),
            cfg.join("microsoft-edge/NativeMessagingHosts"),
        ]
    }
}

#[cfg(not(target_os = "windows"))]
fn firefox_manifest_dirs() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    #[cfg(target_os = "macos")]
    {
        vec![home.join("Library/Application Support/Mozilla/NativeMessagingHosts")]
    }
    #[cfg(not(target_os = "macos"))]
    {
        vec![home.join(".mozilla/native-messaging-hosts")]
    }
}
