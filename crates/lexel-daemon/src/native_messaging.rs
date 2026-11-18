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

/// Run the Chrome/Firefox Native Messaging stdio loop until stdin closes.
pub async fn run_stdio_loop(service: Arc<DaemonService>) -> io::Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = stdin.lock();
    let mut writer = stdout.lock();

    while let Some(bytes) = read_frame(&mut reader)? {
        let resp = match serde_json::from_slice::<NativeEnvelope>(&bytes) {
            Ok(env) => match service.dispatch_rpc(&env.kind, env.payload).await {
                Ok(data) => NativeResponse {
                    id: env.id,
                    ok: true,
                    data: Some(data),
                    error: None,
                },
                Err(err) => NativeResponse {
                    id: env.id,
                    ok: false,
                    data: None,
                    error: Some(err.to_string()),
                },
            },
            Err(err) => {
                warn!("invalid native messaging JSON: {err}");
                NativeResponse {
                    id: None,
                    ok: false,
                    data: None,
                    error: Some(format!("Invalid request JSON: {err}")),
                }
            }
        };

        let encoded = serde_json::to_vec(&resp).map_err(io::Error::other)?;
        write_frame(&mut writer, &encoded)?;
    }

    service.shutdown().await;
    Ok(())
}

/// Install Chrome/Chromium/Brave and Firefox Native Messaging host manifests.
pub fn install_native_hosts(
    daemon_bin: &Path,
    data_dir: &Path,
    chrome_ext_ids: &[String],
) -> io::Result<Vec<PathBuf>> {
    let host_exec = prepare_host_executable(daemon_bin, data_dir)?;
    let host_exec_str = host_exec.display().to_string();

    let chrome_origins: Vec<String> = if chrome_ext_ids.is_empty() {
        vec!["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/".to_owned()]
    } else {
        chrome_ext_ids
            .iter()
            .map(|id| {
                let clean = id.trim().trim_end_matches('/');
                if clean.starts_with("chrome-extension://") {
                    format!("{clean}/")
                } else {
                    format!("chrome-extension://{clean}/")
                }
            })
            .collect()
    };

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

    Ok(written)
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
    #[cfg(not(unix))]
    {
        let _ = data_dir;
        Ok(abs_bin)
    }
}

fn write_manifest(dir: &Path, payload: &serde_json::Value) -> io::Result<Option<PathBuf>> {
    fs::create_dir_all(dir)?;
    let path = dir.join(format!("{NATIVE_HOST_NAME}.json"));
    let body = serde_json::to_string_pretty(payload).map_err(io::Error::other)?;
    fs::write(&path, format!("{body}\n"))?;
    Ok(Some(path))
}

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
        ]
    }
    #[cfg(not(target_os = "macos"))]
    {
        let cfg = dirs::config_dir().unwrap_or_else(|| home.join(".config"));
        vec![
            cfg.join("google-chrome/NativeMessagingHosts"),
            cfg.join("chromium/NativeMessagingHosts"),
            cfg.join("BraveSoftware/Brave-Browser/NativeMessagingHosts"),
        ]
    }
}

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
