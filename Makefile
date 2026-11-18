.PHONY: sync-harper install setup dev-browser build-browser dev-desktop build-desktop tauri-dev typecheck test build rust-check rust-test daemon

install:
	pnpm install

setup:
	bash scripts/setup-models.sh

sync-harper:
	bash scripts/sync-harper.sh

rust-check:
	cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings

rust-test:
	cargo test --workspace

daemon:
	cargo run -p lexel-daemon -- serve

dev-browser:
	pnpm --filter lexel-browser dev

build-browser:
	pnpm run build:browser

dev-desktop:
	pnpm --filter lexel-desktop dev

build-desktop:
	pnpm run build:desktop

tauri-dev:
	pnpm --filter lexel-desktop tauri dev

typecheck:
	pnpm -r typecheck

test:
	pnpm -r test

build:
	pnpm -r build
