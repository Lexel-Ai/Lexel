#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${ROOT_DIR}/dist-release"
WITH_DESKTOP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-desktop)
      WITH_DESKTOP=1
      shift
      ;;
    -h|--help)
      cat <<'EOF'
Usage: scripts/package-release.sh [--with-desktop]

Builds downloadable local release artifacts into dist-release/ with SHA256SUMS.txt:
  - lexel-cli (release binary)
  - lexel-daemon (release binary)
  - lexel-chrome.zip (Chrome / Brave / Edge / Chromium MV3 package)
  - lexel-firefox.zip (Firefox 128+ MV3 package)
  - Optional: Tauri Desktop bundles (.deb, .AppImage, .dmg, .msi, .exe) when --with-desktop is passed
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}"

echo "[1/4] Building release Rust binaries (lexel-cli, lexel-daemon)..."
(cd "${ROOT_DIR}" && cargo build --release -p lexel-cli -p lexel-daemon)
cp "${ROOT_DIR}/target/release/lexel" "${OUT_DIR}/lexel-cli" 2>/dev/null || cp "${ROOT_DIR}/target/release/lexel.exe" "${OUT_DIR}/lexel-cli.exe"
cp "${ROOT_DIR}/target/release/lexel-daemon" "${OUT_DIR}/lexel-daemon" 2>/dev/null || cp "${ROOT_DIR}/target/release/lexel-daemon.exe" "${OUT_DIR}/lexel-daemon.exe"

echo "[2/4] Building browser extension packages (Chrome & Firefox)..."
(cd "${ROOT_DIR}" && pnpm --filter lexel-ui build && pnpm --filter lexel-browser zip:chrome && pnpm --filter lexel-browser zip:firefox)
mv "${ROOT_DIR}/packages/lexel-browser/lexel-chrome.zip" "${OUT_DIR}/lexel-chrome.zip"
mv "${ROOT_DIR}/packages/lexel-browser/lexel-firefox.zip" "${OUT_DIR}/lexel-firefox.zip"

if [[ "${WITH_DESKTOP}" -eq 1 ]]; then
  echo "[3/4] Building Tauri v2 Lexel Desktop installers..."
  (cd "${ROOT_DIR}" && pnpm run tauri:build)
  find "${ROOT_DIR}/apps/lexel-desktop/src-tauri/target/release/bundle" -type f \
    \( -name "*.deb" -o -name "*.AppImage" -o -name "*.rpm" -o -name "*.dmg" -o -name "*.msi" -o -name "*.exe" \) \
    -exec cp {} "${OUT_DIR}/" \;
else
  echo "[3/4] Skipping Tauri desktop installer bundle (pass --with-desktop to include)."
fi

echo "[4/4] Writing SHA256SUMS.txt..."
(
  cd "${OUT_DIR}"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum * > SHA256SUMS.txt
  else
    shasum -a 256 * > SHA256SUMS.txt
  fi
)

echo "Release artifacts ready in ${OUT_DIR}:"
ls -lh "${OUT_DIR}"
