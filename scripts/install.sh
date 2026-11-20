#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/Lexel-Ai/Lexel.git"
RELEASES_BASE="https://github.com/Lexel-Ai/Lexel/releases/latest/download"
RAW_BASE="https://raw.githubusercontent.com/Lexel-Ai/Lexel/main"
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
lexel (CLI), browser extension packages, and Native Messaging bridge.

Options:
  --from-source          Build from local checkout (or clone from GitHub)
  --with-models          Also download verified local AI GGUF models
  --extension-id <id>    Optional Chrome extension ID to pre-register
  --dry-run              Print planned actions without modifying the system
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
    case "${ARCH_NAME}" in
      arm64|aarch64) TARGET="macos-arm64" ;;
      x86_64|amd64) TARGET="macos-x86_64" ;;
      *) TARGET="macos-${ARCH_NAME}" ;;
    esac
    ;;
  Linux)
    LEXEL_DATA_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}/lexel"
    case "${ARCH_NAME}" in
      x86_64|amd64) TARGET="linux-x86_64" ;;
      arm64|aarch64) TARGET="linux-arm64" ;;
      *) TARGET="linux-${ARCH_NAME}" ;;
    esac
    ;;
  *)
    echo "Unsupported OS: ${OS_NAME}. On Windows, use scripts/install.ps1 or the .msi/.exe installer from GitHub Releases." >&2
    exit 1
    ;;
esac

mkdir -p "${BIN_DIR}" "${LEXEL_DATA_DIR}/bin" "${LEXEL_DATA_DIR}/models" "${LEXEL_DATA_DIR}/extensions"

SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

LOCAL_REPO=""
if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/../Cargo.toml" && -d "${SCRIPT_DIR}/../crates/lexel-daemon" ]]; then
  LOCAL_REPO="$(cd "${SCRIPT_DIR}/.." && pwd)"
fi

echo "========================================================"
echo " Lexel Installer (${TARGET})"
echo "========================================================"
echo "Install bin dir : ${BIN_DIR}"
echo "Data directory  : ${LEXEL_DATA_DIR}"

if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo "[dry-run] Target release triple: ${TARGET}"
  echo "[dry-run] Would install lexel-desktop, lexel-daemon, lexel-ls, and lexel into ${BIN_DIR}"
  echo "[dry-run] Would register Native Messaging host manifests for Chrome, Brave, Edge, and Firefox"
  exit 0
fi

install_linux_desktop_entry() {
  local icon_src="${1:-}"
  mkdir -p "${HOME}/.local/share/applications" "${HOME}/.local/share/icons/hicolor/128x128/apps"
  if [[ -n "${icon_src}" && -f "${icon_src}" ]]; then
    cp -f "${icon_src}" "${HOME}/.local/share/icons/hicolor/128x128/apps/lexel-desktop.png"
  else
    curl -fsSL --max-time 15 \
      -o "${HOME}/.local/share/icons/hicolor/128x128/apps/lexel-desktop.png" \
      "${RAW_BASE}/apps/lexel-desktop/src-tauri/icons/128x128.png" 2>/dev/null || true
  fi
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
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "${HOME}/.local/share/applications" 2>/dev/null || true
  fi
}

install_from_repo() {
  local repo_dir="$1"
  echo "[1/4] Building Rust binaries (lexel, lexel-daemon, lexel-ls)..."
  (cd "${repo_dir}" && cargo build --release -p lexel-cli -p lexel-daemon -p lexel-ls)

  install -m 0755 "${repo_dir}/target/release/lexel" "${BIN_DIR}/lexel"
  install -m 0755 "${repo_dir}/target/release/lexel-daemon" "${BIN_DIR}/lexel-daemon"
  install -m 0755 "${repo_dir}/target/release/lexel-daemon" "${LEXEL_DATA_DIR}/bin/lexel-daemon"
  install -m 0755 "${repo_dir}/target/release/lexel-ls" "${BIN_DIR}/lexel-ls"

  if command -v pnpm >/dev/null 2>&1; then
    echo "[2/4] Building Lexel UI kit and Desktop frontend..."
    (cd "${repo_dir}" && pnpm install && pnpm run build:desktop)

    echo "[3/4] Building Lexel Desktop native application..."
    if (cd "${repo_dir}" && cargo build --release --manifest-path apps/lexel-desktop/src-tauri/Cargo.toml); then
      local desktop_bin="${repo_dir}/apps/lexel-desktop/src-tauri/target/release/lexel-desktop"
      if [[ -x "${desktop_bin}" ]]; then
        install -m 0755 "${desktop_bin}" "${BIN_DIR}/lexel-desktop"
        if [[ "${OS_NAME}" == "Linux" ]]; then
          install_linux_desktop_entry "${repo_dir}/apps/lexel-desktop/src-tauri/icons/128x128.png"
        fi
        echo "[ok] Installed Lexel Desktop to ${BIN_DIR}/lexel-desktop"
      fi
    else
      echo "[warn] Could not compile Tauri desktop window (check libwebkit2gtk-4.1-dev / librsvg2-dev on Linux). CLI, LSP, and daemon are installed."
    fi

    if [[ -d "${repo_dir}/vendor/harper/packages/harper.js/dist" && -d "${repo_dir}/vendor/harper/packages/lint-framework/dist" ]]; then
      echo "[info] Building browser extension into packages/lexel-browser/dist..."
      (cd "${repo_dir}" && pnpm run build:browser) || echo "[warn] Browser extension build skipped; download prebuilt zips from GitHub Releases."
    elif command -v wasm-pack >/dev/null 2>&1; then
      echo "[info] Building Harper WASM and browser extension..."
      (
        cd "${repo_dir}/vendor/harper/harper-wasm" &&
        wasm-pack build --target web --out-name harper_wasm &&
        wasm-pack build --target web --out-name harper_wasm_slim --no-default-features &&
        cd "${repo_dir}/vendor/harper" &&
        pnpm install --engine-strict=false &&
        pnpm --filter harper.js build &&
        pnpm --filter lint-framework build &&
        cd "${repo_dir}" &&
        pnpm run build:browser
      ) || echo "[warn] Browser extension build skipped; download prebuilt zips from GitHub Releases."
    else
      echo "[info] Skipping browser extension source build (wasm-pack not installed). Download lexel-chrome.zip / lexel-firefox.zip from GitHub Releases."
    fi
  else
    echo "[warn] pnpm not found in PATH; skipped Lexel Desktop frontend build. Install Node 22 + pnpm or download prebuilt releases."
  fi
}

try_download_release() {
  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "${tmp_dir}"' RETURN

  echo "[1/3] Checking GitHub Releases for prebuilt ${TARGET} packages..."
  if ! curl -fsSL --max-time 60 -o "${tmp_dir}/lexel-daemon" "${RELEASES_BASE}/lexel-daemon-${TARGET}" 2>/dev/null; then
    return 1
  fi

  install -m 0755 "${tmp_dir}/lexel-daemon" "${BIN_DIR}/lexel-daemon"
  install -m 0755 "${tmp_dir}/lexel-daemon" "${LEXEL_DATA_DIR}/bin/lexel-daemon"

  if curl -fsSL --max-time 60 -o "${tmp_dir}/lexel-cli" "${RELEASES_BASE}/lexel-cli-${TARGET}" 2>/dev/null; then
    install -m 0755 "${tmp_dir}/lexel-cli" "${BIN_DIR}/lexel"
  fi

  if curl -fsSL --max-time 60 -o "${tmp_dir}/lexel-ls" "${RELEASES_BASE}/lexel-ls-${TARGET}" 2>/dev/null; then
    install -m 0755 "${tmp_dir}/lexel-ls" "${BIN_DIR}/lexel-ls"
  fi

  echo "[2/3] Downloading Lexel Desktop (${TARGET})..."
  if [[ "${OS_NAME}" == "Linux" ]]; then
    if curl -fsSL --max-time 180 -o "${tmp_dir}/lexel-desktop.AppImage" "${RELEASES_BASE}/lexel-desktop-${TARGET}.AppImage" 2>/dev/null; then
      install -m 0755 "${tmp_dir}/lexel-desktop.AppImage" "${BIN_DIR}/lexel-desktop"
      install_linux_desktop_entry
      echo "[ok] Installed Lexel Desktop AppImage to ${BIN_DIR}/lexel-desktop"
    elif curl -fsSL --max-time 180 -o "${tmp_dir}/lexel-desktop" "${RELEASES_BASE}/lexel-desktop-${TARGET}" 2>/dev/null; then
      install -m 0755 "${tmp_dir}/lexel-desktop" "${BIN_DIR}/lexel-desktop"
      install_linux_desktop_entry
      echo "[ok] Installed Lexel Desktop binary to ${BIN_DIR}/lexel-desktop"
    else
      echo "[warn] Prebuilt Linux Desktop package not found in release; daemon, CLI, and LSP installed."
    fi
  elif [[ "${OS_NAME}" == "Darwin" ]]; then
    local dmg_dest="${LEXEL_DATA_DIR}/lexel-desktop-${TARGET}.dmg"
    if curl -fsSL --max-time 180 -o "${dmg_dest}" "${RELEASES_BASE}/lexel-desktop-${TARGET}.dmg" 2>/dev/null; then
      echo "[ok] Downloaded macOS installer to ${dmg_dest}"
      local mount_point="${tmp_dir}/lexel-dmg"
      mkdir -p "${mount_point}"
      if hdiutil attach "${dmg_dest}" -nobrowse -quiet -mountpoint "${mount_point}" 2>/dev/null; then
        local app_bundle
        app_bundle="$(find "${mount_point}" -maxdepth 1 -name "*.app" | head -n 1 || true)"
        if [[ -n "${app_bundle}" ]]; then
          local app_target="/Applications"
          if [[ ! -w "${app_target}" ]]; then
            app_target="${HOME}/Applications"
            mkdir -p "${app_target}"
          fi
          rm -rf "${app_target}/$(basename "${app_bundle}")"
          cp -R "${app_bundle}" "${app_target}/"
          ln -sf "${app_target}/$(basename "${app_bundle}")/Contents/MacOS/lexel-desktop" "${BIN_DIR}/lexel-desktop" 2>/dev/null || true
          echo "[ok] Installed $(basename "${app_bundle}") into ${app_target}"
        fi
        hdiutil detach "${mount_point}" -quiet 2>/dev/null || true
      fi
    fi
  fi

  echo "[3/3] Downloading Browser, VS Code, and Obsidian extension archives..."
  for ext_zip in lexel-chrome.zip lexel-firefox.zip lexel-obsidian-plugin.zip lexel-vscode.zip; do
    if curl -fsSL --max-time 60 -o "${LEXEL_DATA_DIR}/extensions/${ext_zip}" "${RELEASES_BASE}/${ext_zip}" 2>/dev/null; then
      echo "[ok] Saved ${LEXEL_DATA_DIR}/extensions/${ext_zip}"
    fi
  done

  return 0
}

if [[ -n "${LOCAL_REPO}" && "${FROM_SOURCE}" -eq 1 ]]; then
  install_from_repo "${LOCAL_REPO}"
elif [[ -n "${LOCAL_REPO}" ]]; then
  install_from_repo "${LOCAL_REPO}"
elif [[ "${FROM_SOURCE}" -eq 0 ]] && try_download_release; then
  echo "[ok] Installed prebuilt release binaries."
else
  SRC_DIR="${LEXEL_DATA_DIR}/src"
  echo "[info] Prebuilt release unavailable for ${TARGET}; building from source in ${SRC_DIR}..."
  rm -rf "${SRC_DIR}"
  git clone --recurse-submodules "${REPO_URL}" "${SRC_DIR}"
  install_from_repo "${SRC_DIR}"
fi

echo "[final] Registering Browser Native Messaging Bridge..."
if [[ -x "${BIN_DIR}/lexel-daemon" ]]; then
  "${BIN_DIR}/lexel-daemon" token >/dev/null
  if [[ -n "${CHROME_EXT_ID}" ]]; then
    "${BIN_DIR}/lexel-daemon" install-native-host --extension-id "${CHROME_EXT_ID}" >/dev/null
  else
    "${BIN_DIR}/lexel-daemon" install-native-host >/dev/null
  fi
fi

if [[ "${WITH_MODELS}" -eq 1 ]]; then
  if [[ -n "${LOCAL_REPO}" ]]; then
    bash "${LOCAL_REPO}/scripts/setup-models.sh" --non-interactive --skip-build
  elif [[ -x "${BIN_DIR}/lexel-daemon" ]]; then
    echo "[models] Downloading verified local AI models via lexel-daemon..."
    "${BIN_DIR}/lexel-daemon" download-model lexel-1.5b
    "${BIN_DIR}/lexel-daemon" download-model lexel-0.5b
  fi
fi

echo ""
echo "Lexel installation complete!"
echo "  - Launch Desktop Control Center : ${BIN_DIR}/lexel-desktop"
echo "  - CLI Linter                    : ${BIN_DIR}/lexel check <file>"
echo "  - Language Server (LSP)         : ${BIN_DIR}/lexel-ls --stdio"
if [[ -n "${LOCAL_REPO}" && -d "${LOCAL_REPO}/packages/lexel-browser/dist" ]]; then
  echo "  - Unpacked Browser Extension    : ${LOCAL_REPO}/packages/lexel-browser/dist"
elif [[ -f "${LEXEL_DATA_DIR}/extensions/lexel-chrome.zip" ]]; then
  echo "  - Browser & Editor Extensions   : ${LEXEL_DATA_DIR}/extensions/"
fi
case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *)
    echo ""
    echo "Note: Add ${BIN_DIR} to your PATH to run 'lexel-desktop' and 'lexel' directly:"
    echo "  export PATH=\"${BIN_DIR}:\$PATH\""
    ;;
esac
echo ""
echo "Open Lexel Desktop to configure rules, sync your browser extension, and download the local AI model (Lexel 1.5B or 0.5B)."
