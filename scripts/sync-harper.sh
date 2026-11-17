#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARPER_DIR="$ROOT_DIR/vendor/harper"

echo "Updating vendor/harper submodule..."
git -C "$ROOT_DIR" submodule update --remote --merge vendor/harper

echo "Latest upstream Harper commit:"
git -C "$HARPER_DIR" log -n 1 --oneline

echo "Rebuilding harper-wasm, harper.js, and lint-framework..."
(
  cd "$HARPER_DIR/harper-wasm"
  wasm-pack build --target web --out-name harper_wasm
  wasm-pack build --target web --out-name harper_wasm_slim --no-default-features
)
(
  cd "$HARPER_DIR"
  pnpm install --engine-strict=false
  pnpm --filter harper.js build
  pnpm --filter lint-framework build
)

echo "Upstream Harper sync complete."
