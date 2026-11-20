#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST_PATH="${ROOT_DIR}/models/manifest.json"

MAIN_MODEL=""
NON_INTERACTIVE=0
GGUF_ONLY=0
OLLAMA_ONLY=0
SKIP_BUILD=0
VERIFY_ONLY=0
DRY_RUN=0
CHROME_EXT_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --main-model)
      MAIN_MODEL="${2:-}"
      shift 2
      ;;
    --non-interactive)
      NON_INTERACTIVE=1
      shift
      ;;
    --gguf-only)
      GGUF_ONLY=1
      shift
      ;;
    --ollama-only)
      OLLAMA_ONLY=1
      shift
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --verify-only)
      VERIFY_ONLY=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --extension-id)
      CHROME_EXT_ID="${2:-}"
      shift 2
      ;;
    -h|--help)
      cat <<'EOF'
Usage: scripts/setup-models.sh [options]

Downloads both Lexel local AI models (0.5B Lite and 1.5B Standard), verifies
SHA-256 checksums against models/manifest.json, configures your chosen main model,
builds lexel-daemon, and registers browser Native Messaging manifests.

Options:
  --main-model <0.5b|1.5b>   Select main default model (prompts if interactive)
  --non-interactive          Skip prompts (defaults main model to lexel-1.5b)
  --gguf-only                Skip Ollama pulls; only download GGUF files
  --ollama-only              Skip raw GGUF downloads; only pull Ollama tags
  --skip-build               Skip cargo build of lexel-daemon
  --verify-only              Verify existing GGUF checksums without downloading
  --dry-run                  Print planned actions without downloading or building
  --extension-id <id>        Optional unpacked Chrome extension ID for Native Messaging
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

case "$(uname -s)" in
  Darwin)
    LEXEL_DATA_DIR="${HOME}/Library/Application Support/lexel"
    ;;
  *)
    LEXEL_DATA_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}/lexel"
    ;;
esac

MODELS_DIR="${LEXEL_DATA_DIR}/models"
mkdir -p "${MODELS_DIR}"

normalize_model_choice() {
  case "${1,,}" in
    0.5b|lexel-0.5b|lite|1) echo "lexel-0.5b" ;;
    1.5b|lexel-1.5b|standard|2|"") echo "lexel-1.5b" ;;
    *)
      echo "Invalid --main-model value: $1 (expected 0.5b or 1.5b)" >&2
      exit 1
      ;;
  esac
}

if [[ -n "${MAIN_MODEL}" ]]; then
  MAIN_MODEL="$(normalize_model_choice "${MAIN_MODEL}")"
elif [[ "${NON_INTERACTIVE}" -eq 1 || ! -t 0 ]]; then
  MAIN_MODEL="lexel-1.5b"
else
  echo "Choose your main local AI model (both 0.5B and 1.5B will be installed):"
  echo "  1) Lexel 1.5B (Standard - ~940 MB, fine-tuned rewrite quality)"
  echo "  2) Lexel 0.5B (Lite     - ~469 MB, fastest on 4-8 GB laptops)"
  read -r -p "Main model [1]: " choice
  case "${choice}" in
    2|0.5b|lexel-0.5b) MAIN_MODEL="lexel-0.5b" ;;
    *) MAIN_MODEL="lexel-1.5b" ;;
  esac
fi

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    python3 -c 'import hashlib, sys; h=hashlib.sha256(); f=open(sys.argv[1],"rb");
for c in iter(lambda: f.read(1048576), b""): h.update(c)
print(h.hexdigest())' "$1"
  fi
}

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required to parse models/manifest.json." >&2
  exit 1
fi

mapfile -t MODEL_ROWS < <(python3 -c '
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    data = json.load(f)
for m in data["models"]:
    print("|".join([m["id"], m["ollamaTag"], m["ggufFilename"], m["ggufUrl"], m["sha256"], str(m["sizeBytes"])]))
' "${MANIFEST_PATH}")

echo "Lexel data directory : ${LEXEL_DATA_DIR}"
echo "Models directory     : ${MODELS_DIR}"
echo "Selected main model  : ${MAIN_MODEL}"

if [[ "${DRY_RUN}" -eq 1 ]]; then
  for row in "${MODEL_ROWS[@]}"; do
    IFS='|' read -r id tag filename url sha bytes <<<"${row}"
    echo "[dry-run] Would ensure GGUF: ${MODELS_DIR}/${filename} (${bytes} bytes, sha256=${sha:0:12}...)"
    echo "[dry-run] Would ensure Ollama tag (if ollama running): ${tag}"
  done
  echo "[dry-run] Would build lexel-daemon, set main model=${MAIN_MODEL}, and install native messaging host."
  exit 0
fi

if [[ "${OLLAMA_ONLY}" -eq 0 ]]; then
  for row in "${MODEL_ROWS[@]}"; do
    IFS='|' read -r id tag filename url expected_sha expected_bytes <<<"${row}"
    dest="${MODELS_DIR}/${filename}"

    if [[ -f "${dest}" ]]; then
      actual_sha="$(sha256_file "${dest}")"
      if [[ "${actual_sha}" == "${expected_sha}" ]]; then
        echo "[ok] ${id} verified (${filename})"
        continue
      fi
      if [[ "${VERIFY_ONLY}" -eq 1 ]]; then
        echo "[mismatch] ${dest} sha256=${actual_sha} expected=${expected_sha}" >&2
        exit 1
      fi
      echo "[warn] Checksum mismatch for ${filename}, re-downloading..."
      rm -f "${dest}"
    elif [[ "${VERIFY_ONLY}" -eq 1 ]]; then
      echo "[missing] ${dest}" >&2
      exit 1
    fi

    echo "[download] Fetching ${id} (${filename})..."
    tmp="${dest}.part"
    curl -fL --retry 3 -C - -o "${tmp}" "${url}"
    actual_sha="$(sha256_file "${tmp}")"
    if [[ "${actual_sha}" != "${expected_sha}" ]]; then
      echo "[error] SHA-256 mismatch for ${filename}: got ${actual_sha}, expected ${expected_sha}" >&2
      rm -f "${tmp}"
      exit 1
    fi
    mv "${tmp}" "${dest}"
    echo "[ok] ${id} verified and saved to ${dest}"
  done
fi

if [[ "${VERIFY_ONLY}" -eq 1 ]]; then
  echo "All local model files verified."
  exit 0
fi

if [[ "${GGUF_ONLY}" -eq 0 ]] && command -v ollama >/dev/null 2>&1; then
  if curl -fsS --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    for row in "${MODEL_ROWS[@]}"; do
      IFS='|' read -r id tag filename _ <<<"${row}"
      dest="${MODELS_DIR}/${filename}"
      if [[ "${OLLAMA_ONLY}" -eq 0 && -f "${dest}" ]]; then
        echo "[ollama] Registering ${tag} from local GGUF (${filename})..."
        tmp_mf="$(mktemp)"
        printf 'FROM %s\nPARAMETER num_ctx 2048\n' "${dest}" > "${tmp_mf}"
        ollama create "${tag}" -f "${tmp_mf}" >/dev/null
        rm -f "${tmp_mf}"
      else
        echo "[ollama] Pulling ${tag}..."
        ollama pull "${tag}"
      fi
    done
  else
    echo "[info] Ollama binary found, but server is not running; skipped immediate Ollama registration (lexel-daemon will register GGUFs on first AI toggle)."
  fi
fi

if [[ "${SKIP_BUILD}" -eq 0 ]] && command -v cargo >/dev/null 2>&1; then
  echo "[build] Building lexel-daemon..."
  (cd "${ROOT_DIR}" && cargo build --release -p lexel-daemon)
  DAEMON_BIN="${ROOT_DIR}/target/release/lexel-daemon"
  if [[ -x "${DAEMON_BIN}" ]]; then
    "${DAEMON_BIN}" set-main-model "${MAIN_MODEL}" >/dev/null
    "${DAEMON_BIN}" token >/dev/null
    if [[ -n "${CHROME_EXT_ID}" ]]; then
      "${DAEMON_BIN}" install-native-host --extension-id "${CHROME_EXT_ID}" >/dev/null
    else
      "${DAEMON_BIN}" install-native-host >/dev/null
    fi
    echo "[ok] Native Messaging host installed and main model set to ${MAIN_MODEL}."
    echo "[info] Daemon loopback token path: ${LEXEL_DATA_DIR}/daemon.token (run '${DAEMON_BIN} token' to print)"
  fi
fi
