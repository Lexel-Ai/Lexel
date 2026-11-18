use std::fs;
use std::path::Path;

use uuid::Uuid;

/// Read the existing per-install Bearer token or create one with restricted file permissions.
pub fn ensure_token(token_path: &Path) -> std::io::Result<String> {
    if let Some(parent) = token_path.parent() {
        fs::create_dir_all(parent)?;
    }

    if token_path.exists() {
        let existing = fs::read_to_string(token_path)?;
        let trimmed = existing.trim();
        if trimmed.len() >= 16 {
            return Ok(trimmed.to_owned());
        }
    }

    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    fs::write(token_path, format!("{token}\n"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(0o600);
        let _ = fs::set_permissions(token_path, perms);
    }

    Ok(token)
}

/// Constant-time comparison for Bearer tokens to avoid timing leaks.
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let a_bytes = a.as_bytes();
    let b_bytes = b.as_bytes();
    if a_bytes.len() != b_bytes.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a_bytes.iter().zip(b_bytes.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Strict Origin check allowing only loopback browsers, browser extensions, and Tauri webviews.
pub fn is_allowed_origin(origin: Option<&str>) -> bool {
    let Some(raw) = origin.map(str::trim).filter(|s| !s.is_empty()) else {
        // Native CLI / curl / non-browser clients do not send Origin.
        return true;
    };
    let lower = raw.to_ascii_lowercase();
    if lower.starts_with("chrome-extension://")
        || lower.starts_with("moz-extension://")
        || lower == "tauri://localhost"
        || lower.starts_with("tauri://")
    {
        return true;
    }
    if let Ok(parsed) = url::Url::parse(&lower) {
        let scheme_ok = matches!(parsed.scheme(), "http" | "https");
        let host_ok = matches!(
            parsed.host_str(),
            Some("127.0.0.1") | Some("localhost") | Some("[::1]") | Some("tauri.localhost")
        );
        return scheme_ok && host_ok;
    }
    false
}
