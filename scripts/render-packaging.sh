#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="${LEXEL_GITHUB_REPO:-Lexel-Ai/Lexel}"
TAG=""
CHECKSUMS_FILE=""
OUT_DIR=""

usage() {
  cat <<'EOF'
Usage: scripts/render-packaging.sh --tag <vX.Y.Z> --checksums <SHA256SUMS.txt> --out <dir> [--repo <owner/repo>]

Renders Homebrew (lexel.rb), Arch AUR (PKGBUILD), and Winget manifests from real
SHA256SUMS.txt entries produced by a GitHub Release build. Fails if any required
artifact checksum is missing rather than emitting placeholder hashes.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)
      TAG="${2:-}"
      shift 2
      ;;
    --checksums)
      CHECKSUMS_FILE="${2:-}"
      shift 2
      ;;
    --out)
      OUT_DIR="${2:-}"
      shift 2
      ;;
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "${TAG}" || -z "${CHECKSUMS_FILE}" || -z "${OUT_DIR}" ]]; then
  echo "Missing required flags (--tag, --checksums, --out)." >&2
  usage >&2
  exit 1
fi

if [[ ! -f "${CHECKSUMS_FILE}" ]]; then
  echo "Checksums file not found: ${CHECKSUMS_FILE}" >&2
  exit 1
fi

VERSION="${TAG#v}"
BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"

lookup_sha() {
  local filename="$1"
  local sha
  sha="$(awk -v f="${filename}" '$2 == f || $2 == ("*" f) { print $1; exit }' "${CHECKSUMS_FILE}")"
  if [[ -z "${sha}" ]]; then
    echo "Missing SHA-256 entry for '${filename}' in ${CHECKSUMS_FILE}" >&2
    exit 1
  fi
  if ! [[ "${sha}" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "Invalid SHA-256 format for '${filename}': ${sha}" >&2
    exit 1
  fi
  printf '%s' "${sha,,}"
}

LINUX_TARBALL="lexel-${TAG}-linux-x86_64.tar.gz"
MACOS_TARBALL="lexel-${TAG}-macos-arm64.tar.gz"
WIN_MSI="lexel-desktop-windows-x86_64.msi"

SHA_LINUX="$(lookup_sha "${LINUX_TARBALL}")"
SHA_MACOS="$(lookup_sha "${MACOS_TARBALL}")"
SHA_WIN_MSI_LOWER="$(lookup_sha "${WIN_MSI}")"
SHA_WIN_MSI_UPPER="${SHA_WIN_MSI_LOWER^^}"

URL_LINUX="${BASE_URL}/${LINUX_TARBALL}"
URL_MACOS="${BASE_URL}/${MACOS_TARBALL}"
URL_WIN_MSI="${BASE_URL}/${WIN_MSI}"

mkdir -p "${OUT_DIR}/homebrew" "${OUT_DIR}/aur" "${OUT_DIR}/winget"

render_template() {
  local src="$1"
  local dst="$2"
  sed \
    -e "s|{{VERSION}}|${VERSION}|g" \
    -e "s|{{URL_LINUX_X86_64}}|${URL_LINUX}|g" \
    -e "s|{{SHA256_LINUX_X86_64}}|${SHA_LINUX}|g" \
    -e "s|{{URL_MACOS_ARM64}}|${URL_MACOS}|g" \
    -e "s|{{SHA256_MACOS_ARM64}}|${SHA_MACOS}|g" \
    -e "s|{{URL_WINDOWS_X86_64_MSI}}|${URL_WIN_MSI}|g" \
    -e "s|{{SHA256_WINDOWS_X86_64_MSI}}|${SHA_WIN_MSI_UPPER}|g" \
    "${src}" > "${dst}"
}

render_template "${ROOT_DIR}/packaging/homebrew/lexel.rb.tmpl" "${OUT_DIR}/homebrew/lexel.rb"
render_template "${ROOT_DIR}/packaging/aur/PKGBUILD.tmpl" "${OUT_DIR}/aur/PKGBUILD"
render_template "${ROOT_DIR}/packaging/winget/LexelAI.Lexel.yaml.tmpl" "${OUT_DIR}/winget/LexelAI.Lexel.yaml"
render_template "${ROOT_DIR}/packaging/winget/LexelAI.Lexel.installer.yaml.tmpl" "${OUT_DIR}/winget/LexelAI.Lexel.installer.yaml"
render_template "${ROOT_DIR}/packaging/winget/LexelAI.Lexel.locale.en-US.yaml.tmpl" "${OUT_DIR}/winget/LexelAI.Lexel.locale.en-US.yaml"

echo "Rendered package manifests for ${TAG} into ${OUT_DIR}"
