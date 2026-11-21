use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use lexel_core::scan_secrets;
use lexel_daemon::http::build_router_with_notifier;
use lexel_daemon::models_fs::DownloadModelReport;
use lexel_daemon::native_messaging::{
    NATIVE_HOST_NAME, forward_rpc_to_loopback, install_native_hosts, native_manifest_targets,
    run_stdio_loop,
};
use lexel_daemon::service::{DaemonService, FixAllSafeRequest, SaveVoiceRequest};
use lexel_db::{default_data_dir, default_db_path, default_models_dir, default_token_path};
use serde::Serialize;
use tauri::menu::MenuBuilder;
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tokio::net::TcpListener;
use tracing::{error, info, warn};

const DEFAULT_HTTP_PORT: u16 = 42424;
const GLOBAL_POLISH_SHORTCUT: &str = "CmdOrCtrl+Shift+L";
const REWRITE_BEFORE_PASTE_SHORTCUT: &str = "CmdOrCtrl+Alt+V";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopEnvInfo {
    pub platform: &'static str,
    pub arch: &'static str,
    pub data_dir: String,
    pub db_path: String,
    pub models_dir: String,
    pub daemon_bin: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeHostInstallReport {
    pub daemon_bin: String,
    pub written_manifests: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeHostTargetStatus {
    pub browser: String,
    pub manifest_path: String,
    pub installed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeHostStatusReport {
    pub host_name: &'static str,
    pub daemon_bin: Option<String>,
    pub targets: Vec<NativeHostTargetStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardPolishReport {
    pub original: String,
    pub polished: String,
    pub fixes_applied: usize,
    pub secrets_blocked: usize,
    pub categories: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveWindowSurface {
    pub app_name: Option<String>,
    pub window_title: Option<String>,
    pub detected_surface_id: String,
    pub supported: bool,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RewriteBeforePasteReport {
    pub original: String,
    pub rewritten: String,
    pub surface_id: String,
    pub detected_app: Option<String>,
    pub used_ai: bool,
    pub pasted_automatically: bool,
    pub secrets_blocked: usize,
    pub fixes_applied: usize,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitVoiceSamplePreview {
    pub surface_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitVoiceImportReport {
    pub imported_count: usize,
    pub skipped_secrets_count: usize,
    pub repo_path: String,
    pub samples: Vec<GitVoiceSamplePreview>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsOverlayCapabilities {
    pub platform: &'static str,
    pub global_shortcut: &'static str,
    pub rewrite_before_paste_shortcut: &'static str,
    pub clipboard_polish_ready: bool,
    pub active_window_detection_supported: bool,
    pub native_overlay_mode: &'static str,
    pub notes: &'static str,
}

/// Detect when Chrome/Firefox launches this executable directly as a Native Messaging host.
pub fn should_run_native_messaging_stdio() -> bool {
    std::env::args().skip(1).any(|arg| {
        arg == "native-messaging"
            || arg == "--native-messaging"
            || arg.starts_with("chrome-extension://")
            || arg.starts_with("moz-extension://")
            || arg.ends_with("com.lexel.daemon.json")
    })
}

/// Run headless Native Messaging stdio IPC without initializing a desktop window.
pub fn run_headless_native_messaging() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("failed to start Tokio runtime for native messaging");
    rt.block_on(async {
        let data_dir = default_data_dir();
        let service = Arc::new(
            DaemonService::open(
                data_dir,
                default_db_path(),
                default_models_dir(),
                default_token_path(),
                DEFAULT_HTTP_PORT,
            )
            .expect("failed to open lexel.db for native messaging"),
        );
        let _ = service.token();
        if let Err(err) = run_stdio_loop(service).await {
            error!("native messaging stdio loop failed: {err}");
        }
    });
}

fn find_daemon_binary(data_dir: &Path) -> Option<PathBuf> {
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

    // Fallback to workspace target builds when running in `cargo tauri dev`.
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for rel in ["../../../target/release", "../../../target/debug"] {
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

    // Fall back to the standalone Desktop binary itself, which supports headless `native-messaging`.
    std::env::current_exe().ok().filter(|p| p.is_file())
}

/// Map a detected desktop application name and window title to the best Lexel surface ID.
fn map_app_to_surface(app_name: Option<&str>, window_title: Option<&str>) -> &'static str {
    let combined = format!(
        "{} {}",
        app_name.unwrap_or_default().to_ascii_lowercase(),
        window_title.unwrap_or_default().to_ascii_lowercase()
    );

    if combined.contains("slack")
        || combined.contains("discord")
        || combined.contains("teams")
        || combined.contains("mattermost")
        || combined.contains("zulip")
    {
        return "web_discord_slack";
    }
    if combined.contains("mail")
        || combined.contains("outlook")
        || combined.contains("thunderbird")
        || combined.contains("superhuman")
        || combined.contains("fastmail")
        || combined.contains("gmail")
    {
        return "web_email";
    }
    if combined.contains("github")
        || combined.contains("gitlab")
        || combined.contains("pull request")
    {
        return "web_github_pr";
    }
    if combined.contains("reddit") {
        return "web_reddit";
    }
    if combined.contains("linkedin") {
        return "web_linkedin";
    }
    if combined.contains("obsidian")
        || combined.contains("notion")
        || combined.contains("logseq")
        || combined.contains("typora")
    {
        return "docs_markdown";
    }
    if combined.contains("code")
        || combined.contains("cursor")
        || combined.contains("zed")
        || combined.contains("neovim")
        || combined.contains("helix")
        || combined.contains("jetbrains")
        || combined.contains("rustrover")
        || combined.contains("intellij")
    {
        return "ide_code_comment";
    }
    if combined.contains("terminal")
        || combined.contains("alacritty")
        || combined.contains("kitty")
        || combined.contains("wezterm")
        || combined.contains("ghostty")
        || combined.contains("iterm")
    {
        return "ide_git_commit";
    }
    "general"
}

fn detect_active_window_surface_inner() -> ActiveWindowSurface {
    #[cfg(target_os = "macos")]
    {
        let script = r#"tell application "System Events"
            set frontApp to name of first application process whose frontmost is true
            set winTitle to ""
            try
                set winTitle to name of front window of application process frontApp
            end try
            return frontApp & "\n" & winTitle
        end tell"#;
        if let Ok(output) = Command::new("osascript").args(["-e", script]).output()
            && output.status.success()
        {
            let text = String::from_utf8_lossy(&output.stdout);
            let mut lines = text.lines();
            let app_name = lines
                .next()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned);
            let window_title = lines
                .next()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned);
            let surface = map_app_to_surface(app_name.as_deref(), window_title.as_deref());
            return ActiveWindowSurface {
                app_name,
                window_title,
                detected_surface_id: surface.to_owned(),
                supported: true,
                note: "Detected active macOS window via System Events.".to_owned(),
            };
        }
        return ActiveWindowSurface {
            app_name: None,
            window_title: None,
            detected_surface_id: "general".to_owned(),
            supported: false,
            note: "Grant macOS Accessibility permission to auto-detect the frontmost app, or pick a manual surface override.".to_owned(),
        };
    }

    #[cfg(target_os = "windows")]
    {
        let ps = r#"Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@
$h = [Win32]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 256
[void][Win32]::GetWindowText($h, $sb, 256)
$pidOut = 0
[void][Win32]::GetWindowThreadProcessId($h, [ref]$pidOut)
$proc = (Get-Process -Id $pidOut -ErrorAction SilentlyContinue).ProcessName
Write-Output $proc
Write-Output $sb.ToString()"#;
        if let Ok(output) = Command::new("powershell")
            .args(["-NoProfile", "-Command", ps])
            .output()
            && output.status.success()
        {
            let text = String::from_utf8_lossy(&output.stdout);
            let mut lines = text.lines();
            let app_name = lines
                .next()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned);
            let window_title = lines
                .next()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned);
            let surface = map_app_to_surface(app_name.as_deref(), window_title.as_deref());
            return ActiveWindowSurface {
                app_name,
                window_title,
                detected_surface_id: surface.to_owned(),
                supported: true,
                note: "Detected foreground Windows application.".to_owned(),
            };
        }
        return ActiveWindowSurface {
            app_name: None,
            window_title: None,
            detected_surface_id: "general".to_owned(),
            supported: false,
            note: "Could not query foreground Windows app; using manual override or General."
                .to_owned(),
        };
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // Linux: try Wayland Hyprland (`hyprctl`), Sway (`swaymsg`), then X11 (`xdotool`).
        if let Ok(output) = Command::new("hyprctl")
            .args(["activewindow", "-j"])
            .output()
            && output.status.success()
            && let Ok(val) = serde_json::from_slice::<serde_json::Value>(&output.stdout)
        {
            let app_name = val
                .get("class")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_owned);
            let window_title = val
                .get("title")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_owned);
            let surface = map_app_to_surface(app_name.as_deref(), window_title.as_deref());
            return ActiveWindowSurface {
                app_name,
                window_title,
                detected_surface_id: surface.to_owned(),
                supported: true,
                note: "Detected active Hyprland window.".to_owned(),
            };
        }

        if let Ok(win_out) = Command::new("xdotool")
            .args(["getactivewindow", "getwindowclassname"])
            .output()
            && win_out.status.success()
        {
            let app_name = String::from_utf8_lossy(&win_out.stdout).trim().to_owned();
            let title_out = Command::new("xdotool")
                .args(["getactivewindow", "getwindowname"])
                .output()
                .ok();
            let window_title = title_out
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
                .filter(|s| !s.is_empty());
            let app_opt = if app_name.is_empty() {
                None
            } else {
                Some(app_name)
            };
            let surface = map_app_to_surface(app_opt.as_deref(), window_title.as_deref());
            return ActiveWindowSurface {
                app_name: app_opt,
                window_title,
                detected_surface_id: surface.to_owned(),
                supported: true,
                note: "Detected active X11 window via xdotool.".to_owned(),
            };
        }

        ActiveWindowSurface {
            app_name: None,
            window_title: None,
            detected_surface_id: "general".to_owned(),
            supported: false,
            note: "Active window auto-detection requires X11 (`xdotool`) or Hyprland (`hyprctl`) on Linux. Use manual surface override anytime.".to_owned(),
        }
    }
}

/// Best-effort OS paste keystroke simulation after rewriting clipboard contents.
fn try_simulate_paste() -> bool {
    #[cfg(target_os = "macos")]
    {
        return Command::new("osascript")
            .args([
                "-e",
                r#"tell application "System Events" to keystroke "v" using command down"#,
            ])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
    }

    #[cfg(target_os = "windows")]
    {
        return Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')",
            ])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if Command::new("wtype")
            .args(["-M", "ctrl", "-P", "v", "-p", "v", "-m", "ctrl"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            return true;
        }
        Command::new("xdotool")
            .args(["key", "--clearmodifiers", "ctrl+v"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

struct ExternalLoopbackFlag(Arc<AtomicBool>);
struct ClipboardSurfaceOverride(Mutex<Option<String>>);

#[tauri::command]
async fn daemon_rpc(
    service: State<'_, Arc<DaemonService>>,
    external_loopback: State<'_, ExternalLoopbackFlag>,
    kind: String,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if external_loopback.0.load(Ordering::Relaxed)
        && let Ok(token) = service.token()
        && let Some(forwarded) =
            forward_rpc_to_loopback(service.http_port, &token, &kind, &payload).await
    {
        return forwarded;
    }
    service
        .dispatch_rpc(&kind, payload)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn download_model_with_progress(
    app: AppHandle,
    service: State<'_, Arc<DaemonService>>,
    model_id: String,
) -> Result<DownloadModelReport, String> {
    service
        .download_model_with_progress(&model_id, |progress| {
            let _ = app.emit("lexel://model-download-progress", progress);
        })
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn desktop_env_info(service: State<'_, Arc<DaemonService>>) -> DesktopEnvInfo {
    DesktopEnvInfo {
        platform: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        data_dir: service.data_dir.display().to_string(),
        db_path: default_db_path().display().to_string(),
        models_dir: default_models_dir().display().to_string(),
        daemon_bin: find_daemon_binary(&service.data_dir).map(|p| p.display().to_string()),
    }
}

#[tauri::command]
fn native_host_status(service: State<'_, Arc<DaemonService>>) -> NativeHostStatusReport {
    let targets = native_manifest_targets(&service.data_dir)
        .into_iter()
        .map(|(browser, path)| NativeHostTargetStatus {
            browser: browser.to_owned(),
            installed: path.is_file(),
            manifest_path: path.display().to_string(),
        })
        .collect();

    NativeHostStatusReport {
        host_name: NATIVE_HOST_NAME,
        daemon_bin: find_daemon_binary(&service.data_dir).map(|p| p.display().to_string()),
        targets,
    }
}

#[tauri::command]
fn install_native_messaging(
    service: State<'_, Arc<DaemonService>>,
    extension_ids: Vec<String>,
) -> Result<NativeHostInstallReport, String> {
    let daemon_bin = find_daemon_binary(&service.data_dir).ok_or_else(|| {
        "Could not locate `lexel-daemon` binary or Desktop executable.".to_owned()
    })?;
    let clean_ids: Vec<String> = extension_ids
        .into_iter()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .collect();

    let paths = install_native_hosts(Path::new(&daemon_bin), &service.data_dir, &clean_ids)
        .map_err(|err| err.to_string())?;

    Ok(NativeHostInstallReport {
        daemon_bin: daemon_bin.display().to_string(),
        written_manifests: paths.into_iter().map(|p| p.display().to_string()).collect(),
    })
}

#[tauri::command]
fn read_clipboard_text(app: AppHandle) -> Result<String, String> {
    app.clipboard()
        .read_text()
        .map_err(|err| format!("Failed to read system clipboard: {err}"))
}

#[tauri::command]
fn write_clipboard_text(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard()
        .write_text(text)
        .map_err(|err| format!("Failed to write system clipboard: {err}"))
}

#[tauri::command]
fn detect_active_window_surface() -> ActiveWindowSurface {
    detect_active_window_surface_inner()
}

#[tauri::command]
fn set_clipboard_override_surface(
    override_state: State<'_, ClipboardSurfaceOverride>,
    surface_id: Option<String>,
) {
    if let Ok(mut guard) = override_state.0.lock() {
        *guard = surface_id
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty() && s != "auto");
    }
}

async fn execute_rewrite_before_paste(
    app: &AppHandle,
    service: &Arc<DaemonService>,
    override_surface: Option<String>,
    use_ai: bool,
    attempt_paste: bool,
) -> Result<RewriteBeforePasteReport, String> {
    let original = app
        .clipboard()
        .read_text()
        .map_err(|err| format!("Failed to read system clipboard: {err}"))?;
    if original.trim().is_empty() {
        return Err("Clipboard is empty.".to_owned());
    }

    let detected = detect_active_window_surface_inner();
    let surface_id = override_surface
        .filter(|s| !s.is_empty() && s != "auto")
        .unwrap_or_else(|| detected.detected_surface_id.clone());

    let profile = service.active_profile().map_err(|err| err.to_string())?;
    let secret_hits = scan_secrets(&original);
    if !secret_hits.is_empty() && !profile.settings.redact_secrets {
        let report = RewriteBeforePasteReport {
            original: original.clone(),
            rewritten: original,
            surface_id,
            detected_app: detected.app_name,
            used_ai: false,
            pasted_automatically: false,
            secrets_blocked: secret_hits.len(),
            fixes_applied: 0,
            note: "Secrets Guard blocked Rewrite Before Paste because credentials were detected."
                .to_owned(),
        };
        let _ = app.emit("lexel://rewrite-before-paste", &report);
        return Ok(report);
    }

    let mut rewritten = original.clone();
    let mut used_ai = false;
    let mut fixes_applied = 0usize;

    if use_ai && profile.settings.ai_enabled {
        let payload = serde_json::json!({
            "text": original,
            "task": "deslop",
            "surfaceId": surface_id,
        });
        if let Ok(val) = service.dispatch_rpc("rewrite", payload).await
            && let Some(suggestion) = val.get("suggestion").and_then(|v| v.as_str())
            && !suggestion.trim().is_empty()
        {
            rewritten = suggestion.to_owned();
            used_ai = !val
                .get("fastPath")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if rewritten != original {
                fixes_applied = 1;
            }
        }
    }

    if rewritten == original && secret_hits.is_empty() {
        let fixed = service
            .fix_all_safe(FixAllSafeRequest {
                text: original.clone(),
                surface_id: Some(surface_id.clone()),
                language: None,
            })
            .map_err(|err| err.to_string())?;
        if fixed.fixes_applied > 0 {
            rewritten = fixed.text;
            fixes_applied = fixed.fixes_applied;
        }
    }

    if rewritten != original {
        app.clipboard()
            .write_text(rewritten.clone())
            .map_err(|err| format!("Failed to update clipboard: {err}"))?;
    }

    let pasted_automatically = if attempt_paste && rewritten != original {
        try_simulate_paste()
    } else {
        false
    };

    let note = if rewritten == original {
        format!("Clipboard text is already clean for {surface_id}.")
    } else if pasted_automatically {
        format!("Rewrote clipboard for {surface_id} and pasted cleanly.")
    } else {
        format!("Rewrote clipboard for {surface_id}. Press Ctrl/Cmd+V to paste.")
    };

    let report = RewriteBeforePasteReport {
        original,
        rewritten,
        surface_id,
        detected_app: detected.app_name,
        used_ai,
        pasted_automatically,
        secrets_blocked: 0,
        fixes_applied,
        note,
    };
    let _ = app.emit("lexel://rewrite-before-paste", &report);
    Ok(report)
}

#[tauri::command]
async fn rewrite_before_paste(
    app: AppHandle,
    service: State<'_, Arc<DaemonService>>,
    override_state: State<'_, ClipboardSurfaceOverride>,
    surface_id: Option<String>,
    use_ai: Option<bool>,
) -> Result<RewriteBeforePasteReport, String> {
    let manual_override =
        surface_id.or_else(|| override_state.0.lock().ok().and_then(|g| g.clone()));
    execute_rewrite_before_paste(
        &app,
        &service,
        manual_override,
        use_ai.unwrap_or(true),
        false,
    )
    .await
}

#[tauri::command]
fn import_git_log_voice(
    service: State<'_, Arc<DaemonService>>,
    repo_path: String,
    author: Option<String>,
    limit: Option<usize>,
) -> Result<GitVoiceImportReport, String> {
    let path = PathBuf::from(repo_path.trim());
    if !path.is_dir() {
        return Err(format!(
            "Repository directory does not exist: {}",
            path.display()
        ));
    }

    let max_commits = limit.unwrap_or(25).clamp(1, 100);
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(&path)
        .arg("log")
        .arg("--no-merges")
        .arg(format!("-n{max_commits}"))
        .arg("--pretty=format:%s%n%b%x1d");
    if let Some(a) = author.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        cmd.arg(format!("--author={a}"));
    }

    let output = cmd
        .output()
        .map_err(|err| format!("Failed to run git log: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git log failed: {}", stderr.trim()));
    }

    let raw = String::from_utf8_lossy(&output.stdout);
    let mut imported_count = 0usize;
    let mut skipped_secrets_count = 0usize;
    let mut samples = Vec::new();

    for entry in raw.split('\u{001d}') {
        let cleaned = entry.trim();
        if cleaned.len() < 12 {
            continue;
        }
        if !scan_secrets(cleaned).is_empty() {
            skipped_secrets_count += 1;
            continue;
        }
        let clipped: String = cleaned.chars().take(600).collect();
        service
            .save_voice_example(SaveVoiceRequest {
                surface_id: "ide_git_commit".to_owned(),
                subcontext: path.file_name().and_then(|n| n.to_str()).map(str::to_owned),
                original: clipped.clone(),
                rewritten: clipped.clone(),
                action: Some("imported".to_owned()),
            })
            .map_err(|err| err.to_string())?;
        imported_count += 1;
        if samples.len() < 8 {
            samples.push(GitVoiceSamplePreview {
                surface_id: "ide_git_commit".to_owned(),
                text: clipped,
            });
        }
    }

    Ok(GitVoiceImportReport {
        imported_count,
        skipped_secrets_count,
        repo_path: path.display().to_string(),
        samples,
    })
}

#[tauri::command]
fn polish_clipboard_safe(
    app: AppHandle,
    service: State<'_, Arc<DaemonService>>,
    surface_id: Option<String>,
) -> Result<ClipboardPolishReport, String> {
    let original = app
        .clipboard()
        .read_text()
        .map_err(|err| format!("Failed to read system clipboard: {err}"))?;
    if original.trim().is_empty() {
        return Err("Clipboard is empty.".to_owned());
    }

    let secret_hits = scan_secrets(&original);
    if !secret_hits.is_empty() {
        return Ok(ClipboardPolishReport {
            original: original.clone(),
            polished: original,
            fixes_applied: 0,
            secrets_blocked: secret_hits.len(),
            categories: vec!["secrets_guard".to_owned()],
        });
    }

    let fixed = service
        .fix_all_safe(FixAllSafeRequest {
            text: original.clone(),
            surface_id,
            language: None,
        })
        .map_err(|err| err.to_string())?;

    if fixed.fixes_applied > 0 {
        app.clipboard()
            .write_text(fixed.text.clone())
            .map_err(|err| format!("Failed to update clipboard: {err}"))?;
    }

    Ok(ClipboardPolishReport {
        original,
        polished: fixed.text,
        fixes_applied: fixed.fixes_applied,
        secrets_blocked: 0,
        categories: fixed.categories,
    })
}

#[tauri::command]
fn os_overlay_capabilities() -> OsOverlayCapabilities {
    let detected = detect_active_window_surface_inner();
    #[cfg(target_os = "macos")]
    {
        OsOverlayCapabilities {
            platform: "macos",
            global_shortcut: GLOBAL_POLISH_SHORTCUT,
            rewrite_before_paste_shortcut: REWRITE_BEFORE_PASTE_SHORTCUT,
            clipboard_polish_ready: true,
            active_window_detection_supported: detected.supported,
            native_overlay_mode: "global_hotkey_and_ax_ready",
            notes: "Cmd+Shift+L opens clipboard text in Studio; Cmd+Alt+V runs Rewrite Before Paste using frontmost app detection.",
        }
    }
    #[cfg(target_os = "windows")]
    {
        OsOverlayCapabilities {
            platform: "windows",
            global_shortcut: GLOBAL_POLISH_SHORTCUT,
            rewrite_before_paste_shortcut: REWRITE_BEFORE_PASTE_SHORTCUT,
            clipboard_polish_ready: true,
            active_window_detection_supported: detected.supported,
            native_overlay_mode: "global_hotkey_and_uia_ready",
            notes: "Ctrl+Shift+L opens clipboard text in Studio; Ctrl+Alt+V runs Rewrite Before Paste across desktop apps.",
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        OsOverlayCapabilities {
            platform: std::env::consts::OS,
            global_shortcut: GLOBAL_POLISH_SHORTCUT,
            rewrite_before_paste_shortcut: REWRITE_BEFORE_PASTE_SHORTCUT,
            clipboard_polish_ready: true,
            active_window_detection_supported: detected.supported,
            native_overlay_mode: "global_hotkey_clipboard",
            notes: "Ctrl+Shift+L opens clipboard text in Studio; Ctrl+Alt+V runs Rewrite Before Paste across Linux desktop apps.",
        }
    }
}

fn trigger_clipboard_draft_open(app: &AppHandle) {
    show_main_window(app);
    if let Ok(text) = app.clipboard().read_text()
        && !text.trim().is_empty()
    {
        let _ = app.emit("lexel://clipboard-draft", text);
    }
}

fn trigger_rewrite_before_paste(app: &AppHandle) {
    let handle = app.clone();
    let service: Arc<DaemonService> = app.state::<Arc<DaemonService>>().inner().clone();
    let manual_override = app
        .state::<ClipboardSurfaceOverride>()
        .0
        .lock()
        .ok()
        .and_then(|g| g.clone());

    tauri::async_runtime::spawn(async move {
        if let Err(err) =
            execute_rewrite_before_paste(&handle, &service, manual_override, true, true).await
        {
            warn!("Rewrite Before Paste failed: {err}");
        }
    });
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text("open-main", "Open Lexel Desktop")
        .text(
            "clipboard-draft",
            "Check Clipboard in Studio (Ctrl+Shift+L)",
        )
        .text("rewrite-before-paste", "Rewrite Before Paste (Ctrl+Alt+V)")
        .text("unload-ai", "Unload Local AI Model")
        .text("quit", "Quit Lexel")
        .build()?;

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().0.as_str() {
            "open-main" => show_main_window(app),
            "clipboard-draft" => trigger_clipboard_draft_open(app),
            "rewrite-before-paste" => trigger_rewrite_before_paste(app),
            "unload-ai" => {
                let service: Arc<DaemonService> = app.state::<Arc<DaemonService>>().inner().clone();
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(err) = service
                        .dispatch_rpc("unloadAi", serde_json::json!({}))
                        .await
                    {
                        error!("failed to unload local AI from tray: {err}");
                    } else {
                        let _ = handle.emit("lexel://state-changed", "ai");
                    }
                });
            }
            "quit" => app.exit(0),
            other => error!("unexpected tray event: {other}"),
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    let _tray = builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .try_init();

    let data_dir = default_data_dir();
    let db_path = default_db_path();
    let models_dir = default_models_dir();
    let token_path = default_token_path();

    let service = Arc::new(
        DaemonService::open(data_dir, db_path, models_dir, token_path, DEFAULT_HTTP_PORT)
            .expect("failed to initialize Lexel local database"),
    );

    let shared_http_service = Arc::clone(&service);
    let idle_service = Arc::clone(&service);
    let shutdown_service = Arc::clone(&service);
    let external_loopback_flag = Arc::new(AtomicBool::new(false));
    let setup_loopback_flag = Arc::clone(&external_loopback_flag);

    let rewrite_paste_shortcut: Option<Shortcut> = REWRITE_BEFORE_PASTE_SHORTCUT.parse().ok();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        if rewrite_paste_shortcut.as_ref() == Some(shortcut) {
                            trigger_rewrite_before_paste(app);
                        } else {
                            trigger_clipboard_draft_open(app);
                        }
                    }
                })
                .build(),
        )
        .manage(service)
        .manage(ExternalLoopbackFlag(external_loopback_flag))
        .manage(ClipboardSurfaceOverride(Mutex::new(None)))
        .setup(move |app| {
            setup_tray(app.handle())?;

            if let Err(err) = app.global_shortcut().register(GLOBAL_POLISH_SHORTCUT) {
                warn!("global shortcut {GLOBAL_POLISH_SHORTCUT} unavailable: {err}");
            }
            if let Err(err) = app.global_shortcut().register(REWRITE_BEFORE_PASTE_SHORTCUT) {
                warn!("global shortcut {REWRITE_BEFORE_PASTE_SHORTCUT} unavailable: {err}");
            }

            // Ensure default Native Messaging host manifests exist on first Desktop launch.
            if let Some(daemon_bin) = find_daemon_binary(&shared_http_service.data_dir) {
                let _ = install_native_hosts(&daemon_bin, &shared_http_service.data_dir, &[]);
            }

            // Enforce configured idle auto-unload TTL inside Desktop mode too.
            let idle_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut ticker = tokio::time::interval(Duration::from_secs(15));
                loop {
                    ticker.tick().await;
                    idle_service.maybe_idle_unload().await;
                    let _ = &idle_handle;
                }
            });

            // Host the shared loopback daemon so Chrome/Firefox Native Messaging shares one model
            // in RAM and notifies the Desktop UI immediately on external setting changes.
            let daemon_service = Arc::clone(&shared_http_service);
            let event_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match daemon_service.token() {
                    Ok(token) => {
                        let addr = SocketAddr::from(([127, 0, 0, 1], DEFAULT_HTTP_PORT));
                        match TcpListener::bind(addr).await {
                            Ok(listener) => {
                                info!(%addr, "Lexel Desktop hosting shared daemon HTTP bridge");
                                let notifier = Arc::new(move |kind: &str| {
                                    let _ = event_handle.emit("lexel://state-changed", kind);
                                });
                                let router =
                                    build_router_with_notifier(daemon_service, token, Some(notifier));
                                if let Err(err) = axum::serve(listener, router).await {
                                    warn!("shared daemon server exited: {err}");
                                }
                            }
                            Err(err) => {
                                setup_loopback_flag.store(true, Ordering::Relaxed);
                                info!(
                                    %addr,
                                    "loopback daemon port already bound ({err}); forwarding RPCs to external daemon"
                                );
                            }
                        }
                    }
                    Err(err) => warn!("could not ensure daemon.token: {err}"),
                }
            });

            info!("Lexel Desktop initialized");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            daemon_rpc,
            download_model_with_progress,
            desktop_env_info,
            native_host_status,
            install_native_messaging,
            read_clipboard_text,
            write_clipboard_text,
            detect_active_window_surface,
            set_clipboard_override_surface,
            rewrite_before_paste,
            import_git_log_voice,
            polish_clipboard_safe,
            os_overlay_capabilities,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Lexel Desktop");

    app.run(move |_app_handle, event| {
        if let RunEvent::Exit = event {
            tauri::async_runtime::block_on(shutdown_service.shutdown());
        }
    });
}
