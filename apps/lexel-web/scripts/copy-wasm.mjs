import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptDir, '..');
const srcWasm = resolve(appRoot, '../../packages/lexel-wasm/pkg/lexel_wasm_bg.wasm');
const destDir = resolve(appRoot, 'public/wasm');
const destWasm = resolve(destDir, 'lexel_wasm_bg.wasm');

if (!existsSync(srcWasm)) {
  console.warn(
    `[lexel-web] Warning: ${srcWasm} not found. Playground will use lexel-ui JS fallback until lexel-wasm is built.`,
  );
  process.exit(0);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(srcWasm, destWasm);
console.log(`[lexel-web] Copied lexel_wasm_bg.wasm -> public/wasm/lexel_wasm_bg.wasm`);
