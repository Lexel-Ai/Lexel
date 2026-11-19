#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/Lexel-Ai/Lexel.git"
RELEASES_BASE="https://github.com/Lexel-Ai/Lexel/releases/latest/download"
BIN_DIR="${HOME}/.local/bin"

FROM_SOURCE=0
WITH_MODELS=0
DRY_RUN=0
CHROME_EXT_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-source)
      FROM_SOURCE=1
      shift
      ;;
    --with-models)
      WITH_MODELS=1
      shift
      ;;
    --extension-id)
      CHROME_EXT_ID="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      cat <<'EOF'
Usage: scripts/install.sh [options]

One-command installer for Lexel Desktop, lexel-daemon, lexel-ls (LSP),
lexel-cli, and the Browser Extension Native Messaging bridge.

Options:
  --from-source          Build from local checkout (or clone from GitHub)
  --with-models          Also download GGUF local AI models during install
  --extension-id <id>    Optional Chrome extension ID to pre-register
  --dry-run              Print actions without modifying the system
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

OS_NAME="$(uname -s)"
ARCH_NAME="$(uname -m)"

case "${OS_NAME}" in
  Darwin)
    LEXEL_DATA_DIR="${HOME}/Library/Application Support/lexel"
    ;;
  *)
    LEXEL_DATA_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}/lexel"
    ;;
esac

mkdir -p "${BIN_DIR}" "${LEXEL_DATA_DIR}/bin" "${LEXEL_DATA_DIR}/models"

SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

LOCAL_REPO=""
if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/../Cargo.toml" && -d "${SCRIPT_DIR}/../crates/lexel-daemon" ]]; then
  LOCAL_REPO="$(cd "${SCRIPT_DIR}/.." && pwd)"
fi

echo "========================================================"
echo " Lexel Universal Installer (${OS_NAME}/${ARCH_NAME})"
echo "========================================================"
echo "Install bin dir : ${BIN_DIR}"
echo "Data directory  : ${LEXEL_DATA_DIR}"

if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo "[dry-run] Would install lexel-desktop, lexel-daemon, lexel-ls, and lexel into ${BIN_DIR}"
  echo "[dry-run] Would register Native Messaging host manifests for Chrome, Brave, Edge, and Firefox"
  exit 0
fi

install_from_repo() {
  local repo_dir="$1"
  echo "[1/4] Building Rust binaries (lexel, lexel-daemon, lexel-ls)..."
  (cd "${repo_dir}" && cargo build --release -p lexel-cli -p lexel-daemon -p lexel-ls)

  install -m 0755 "${repo_dir}/target/release/lexel" "${BIN_DIR}/lexel"
  install -m 0755 "${repo_dir}/target/release/lexel-daemon" "${BIN_DIR}/lexel-daemon"
  install -m 0755 "${repo_dir}/target/release/lexel-daemon" "${LEXEL_DATA_DIR}/bin/lexel-daemon"
  install -m 0755 "${repo_dir}/target/release/lexel-ls" "${BIN_DIR}/lexel-ls"

  if command -v pnpm >/dev/null 2>&1; then
    echo "[2/4] Building UI kit, Browser Extension, and Lexel Desktop frontend..."
    (cd "${repo_dir}" && pnpm install && pnpm run build:browser && pnpm run build:desktop)

    echo "[3/4] Building Lexel Desktop native application..."
    if (cd "${repo_dir}" && cargo build --release --manifest-path apps/lexel-desktop/src-tauri/Cargo.toml); then
      local desktop_bin="${repo_dir}/apps/lexel-desktop/src-tauri/target/release/lexel-desktop"
      if [[ -x "${desktop_bin}" ]]; then
        install -m 0755 "${desktop_bin}" "${BIN_DIR}/lexel-desktop"
        if [[ "${OS_NAME}" == "Linux" ]]; then
          mkdir -p "${HOME}/.local/share/applications" "${HOME}/.local/share/icons/hicolor/128x128/apps"
          cp -f "${repo_dir}/apps/lexel-desktop/src-tauri/icons/128x128.png" \
            "${HOME}/.local/share/icons/hicolor/128x128/apps/lexel-desktop.png" 2>/dev/null || true
          cat > "${HOME}/.local/share/applications/lexel-desktop.desktop" <<DESKTOP_EOF
[Desktop Entry]
Name=Lexel Desktop
Comment=100% Local Grammar, Anti-Slop & AI Writing Control Center
Exec=${BIN_DIR}/lexel-desktop
Icon=lexel-desktop
Terminal=false
Type=Application
Categories=Utility;TextEditor;Development;
StartupWMClass=lexel-desktop
DESKTOP_EOF
        fi
      fi
    else
      echo "[warn] Could not compile Tauri desktop window (missing system webkit2gtk dev headers). CLI and daemon are installed."
    fi
  fi
}

try_download_release() {
  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "${tmp_dir}"' RETURN

  echo "[1/3] Checking GitHub Releases for prebuilt binaries..."
  if curl -fsSL --max-time 15 -o "${tmp_dir}/lexel-daemon" "${RELEASES_BASE}/lexel-daemon" 2>/dev/null; then
    install -m 0755 "${tmp_dir}/lexel-daemon" "${BIN_DIR}/lexel-daemon"
    install -m 0755 "${tmp_dir}/lexel-daemon" "${LEXEL_DATA_DIR}/bin/lexel-daemon"
    if curl -fsSL --max-time 15 -o "${tmp_dir}/lexel-cli" "${RELEASES_BASE}/lexel-cli" 2>/dev/null; then
      install -m 0755 "${tmp_dir}/lexel-cli" "${BIN_DIR}/lexel"
    fi
    if curl -fsSL --max-time 15 -o "${tmp_dir}/lexel-ls" "${RELEASES_BASE}/lexel-ls" 2>/dev/null; then
      install -m 0755 "${tmp_dir}/lexel-ls" "${BIN_DIR}/lexel-ls"
    fi
    if curl -fsSL --max-time 15 -o "${LEXEL_DATA_DIR}/lexel-chrome.zip" "${RELEASES_BASE}/lexel-chrome.zip" 2>/dev/null; then
      echo "[ok] Downloaded browser extension package to ${LEXEL_DATA_DIR}/lexel-chrome.zip"
    fi
    return 0
  fi
  return 1
}

if [[ -n "${LOCAL_REPO}" ]]; then
  install_from_repo "${LOCAL_REPO}"
elif [[ "${FROM_SOURCE}" -eq 0 ]] && try_download_release; then
  echo "[ok] Installed prebuilt release binaries."
else
  SRC_DIR="${LEXEL_DATA_DIR}/src"
  echo "[info] Cloning Lexel repository to ${SRC_DIR}..."
  rm -rf "${SRC_DIR}"
  git clone --recurse-submodules "${REPO_URL}" "${SRC_DIR}"
  install_from_repo "${SRC_DIR}"
fi

echo "[4/4] Registering Browser Native Messaging Bridge..."
if [[ -x "${BIN_DIR}/lexel-daemon" ]]; then
  "${BIN_DIR}/lexel-daemon" token >/dev/null
  if [[ -n "${CHROME_EXT_ID}" ]]; then
    "${BIN_DIR}/lexel-daemon" install-native-host --extension-id "${CHROME_EXT_ID}" >/dev/null
  else
    "${BIN_DIR}/lexel-daemon" install-native-host >/dev/null
  fi
fi

if [[ "${WITH_MODELS}" -eq 1 && -n "${LOCAL_REPO}" ]]; then
  bash "${LOCAL_REPO}/scripts/setup-models.sh" --non-interactive --skip-build
fi

echo ""
echo "Lexel installation complete!"
echo "  - Launch Desktop Control Center : ${BIN_DIR}/lexel-desktop"
echo "  - CLI Linter                    : ${BIN_DIR}/lexel check <file>"
echo "  - Language Server (LSP)         : ${BIN_DIR}/lexel-ls --stdio"
if [[ -n "${LOCAL_REPO}" && -d "${LOCAL_REPO}/packages/lexel-browser/dist" ]]; then
  echo "  - Unpacked Browser Extension    : ${LOCAL_REPO}/packages/lexel-browser/dist"
fi
echo ""
echo "Open Lexel Desktop to configure settings, rules, and download the local AI model (Lexel 1.5B or 0.5B)."
