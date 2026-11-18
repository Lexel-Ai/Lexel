.PHONY: sync-harper install dev-browser build-browser dev-lab build-lab typecheck test build

install:
	pnpm install

sync-harper:
	bash scripts/sync-harper.sh

dev-browser:
	pnpm --filter lexel-browser dev

build-browser:
	pnpm run build:browser

dev-lab:
	pnpm --filter lexel-lab dev

build-lab:
	pnpm run build:lab

typecheck:
	pnpm -r typecheck

test:
	pnpm -r test

build:
	pnpm -r build
