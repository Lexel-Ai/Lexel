use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use lexel_daemon::http::build_router_with_notifier;
use lexel_daemon::models_fs::DownloadModelReport;
use lexel_daemon::native_messaging::{
    NATIVE_HOST_NAME, install_native_hosts, native_manifest_targets, run_stdio_loop,
};
use lexel_daemon::service::DaemonService;
use lexel_db::{default_data_dir, default_db_path, default_models_dir, default_token_path};
use serde::Serialize;
use tauri::menu::MenuBuilder;
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tokio::net::TcpListener;
use tracing::{error, info, warn};

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

    let app = tauri::Builder::default()
        .manage(service)
        .setup(move |app| {
            setup_tray(app.handle())?;

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
                                info!(
                                    %addr,
                                    "loopback daemon port already bound ({err}); reusing external daemon"
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
        ])
        .build(tauri::generate_context!())
        .expect("error while building Lexel Desktop");

    app.run(move |_app_handle, event| {
        if let RunEvent::Exit = event {
            tauri::async_runtime::block_on(shutdown_service.shutdown());
        }
    });
}
