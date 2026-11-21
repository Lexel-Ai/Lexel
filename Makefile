.PHONY: sync-harper install install-app install-hooks setup dev-browser build-browser zip-browser dev-desktop build-desktop tauri-dev tauri-build package lint format check typecheck test build rust-check rust-test daemon doctor bench ci-docs ml-test

install:
	pnpm install

install-app:
	bash scripts/install.sh

install-hooks:
	git config core.hooksPath scripts/hooks

setup:
	bash scripts/setup-models.sh

sync-harper:
	bash scripts/sync-harper.sh

rust-check:
	cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings && cargo fmt --manifest-path apps/lexel-desktop/src-tauri/Cargo.toml --check && cargo clippy --manifest-path apps/lexel-desktop/src-tauri/Cargo.toml --all-targets -- -D warnings

rust-test:
	cargo test --workspace

daemon:
	cargo run -p lexel-daemon -- serve

doctor:
	cargo run -p lexel-cli -- doctor

bench:
	cargo run -p lexel-cli -- bench

ci-docs:
	cargo run -p lexel-cli -- check --ci README.md docs/ci-github-actions.md

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

lint:
	pnpm run lint

format:
	cargo fmt && cargo fmt --manifest-path apps/lexel-desktop/src-tauri/Cargo.toml && pnpm run format

check:
	$(MAKE) rust-check && pnpm run check && pnpm -r typecheck

typecheck:
	pnpm -r typecheck

test:
	pnpm -r test

ml-test:
	uv run pytest

build:
	pnpm -r build
