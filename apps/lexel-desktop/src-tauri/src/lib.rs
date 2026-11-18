use std::path::{Path, PathBuf};
use std::sync::Arc;

use lexel_daemon::native_messaging::{NATIVE_HOST_NAME, install_native_hosts};
use lexel_daemon::service::DaemonService;
use lexel_db::{default_data_dir, default_db_path, default_models_dir, default_token_path};
use serde::Serialize;
use tauri::menu::MenuBuilder;
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, State};
use tracing::{error, info};

const DEFAULT_HTTP_PORT: u16 = 42424;

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

fn find_daemon_binary() -> Option<PathBuf> {
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

    None
}

fn native_manifest_targets() -> Vec<(&'static str, PathBuf)> {
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
                "Firefox",
                home.join(".mozilla/native-messaging-hosts").join(&filename),
            ),
        ]
    }
}

#[tauri::command]
async fn daemon_rpc(
    service: State<'_, Arc<DaemonService>>,
    kind: String,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    service
        .dispatch_rpc(&kind, payload)
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
        daemon_bin: find_daemon_binary().map(|p| p.display().to_string()),
    }
}

#[tauri::command]
fn native_host_status() -> NativeHostStatusReport {
    let targets = native_manifest_targets()
        .into_iter()
        .map(|(browser, path)| NativeHostTargetStatus {
            browser: browser.to_owned(),
            installed: path.is_file(),
            manifest_path: path.display().to_string(),
        })
        .collect();

    NativeHostStatusReport {
        host_name: NATIVE_HOST_NAME,
        daemon_bin: find_daemon_binary().map(|p| p.display().to_string()),
        targets,
    }
}

#[tauri::command]
fn install_native_messaging(
    service: State<'_, Arc<DaemonService>>,
    extension_ids: Vec<String>,
) -> Result<NativeHostInstallReport, String> {
    let daemon_bin = find_daemon_binary().ok_or_else(|| {
        "Could not locate `lexel-daemon` binary. Run `cargo build -p lexel-daemon` first."
            .to_owned()
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

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text("open-main", "Open Lexel Control Center")
        .text("unload-ai", "Unload Local AI Model")
        .text("quit", "Quit Lexel")
        .build()?;

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().0.as_str() {
            "open-main" => show_main_window(app),
            "unload-ai" => {
                let service: Arc<DaemonService> = app.state::<Arc<DaemonService>>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(err) = service
                        .dispatch_rpc("unloadAi", serde_json::json!({}))
                        .await
                    {
                        error!("failed to unload local AI from tray: {err}");
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

    tauri::Builder::default()
        .manage(service)
        .setup(|app| {
            setup_tray(app.handle())?;
            info!("Lexel Desktop initialized");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            daemon_rpc,
            desktop_env_info,
            native_host_status,
            install_native_messaging,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lexel Desktop");
}
