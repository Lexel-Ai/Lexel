.PHONY: sync-harper install install-hooks setup dev-browser build-browser zip-browser dev-desktop build-desktop tauri-dev tauri-build package typecheck test build rust-check rust-test daemon

install:
	pnpm install

install-hooks:
	git config core.hooksPath scripts/hooks

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

zip-browser:
	pnpm --filter lexel-ui build && pnpm --filter lexel-browser zip:chrome && pnpm --filter lexel-browser zip:firefox

dev-desktop:
	pnpm --filter lexel-desktop dev

build-desktop:
	pnpm run build:desktop

tauri-dev:
	pnpm --filter lexel-desktop tauri dev

tauri-build:
	pnpm run tauri:build

package:
	bash scripts/package-release.sh --with-desktop

typecheck:
	pnpm -r typecheck

test:
	pnpm -r test

build:
	pnpm -r build
