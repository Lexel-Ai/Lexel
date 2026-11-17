.PHONY: sync-harper install dev-browser build-browser typecheck test build

install:
	pnpm install

sync-harper:
	bash scripts/sync-harper.sh

dev-browser:
	pnpm --filter lexel-browser dev

build-browser:
	pnpm run build:browser

typecheck:
	pnpm -r typecheck

test:
	pnpm -r test

build:
	pnpm -r build
