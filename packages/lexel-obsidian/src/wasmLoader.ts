import {
  createLexelWasmEngine,
  initLexelWasmSync,
  LexelWasmEngine,
  type WasmInitInput,
} from 'lexel-wasm';
import { registerObsidianWasmAdapter } from './analyzer';

let activeEngine: LexelWasmEngine | null = null;

function bindEngine(engine: LexelWasmEngine): void {
  activeEngine = engine;
  registerObsidianWasmAdapter({
    lintMarkdown: (text: string) => {
      const report = engine.check(text, {
        surfaceId: 'docs_markdown',
        language: 'markdown',
      });
      return {
        harperCount: report.harper.length,
        slopScore: report.slopMeter.score,
      };
    },
  });
}

/**
 * Initialize zero-daemon `lexel-wasm` in Obsidian. If WASM bytes cannot be fetched in the
 * current vault layout, returns `false` cleanly so Obsidian stays on the TS Tier 0 fallback.
 */
export async function initObsidianLexelWasm(input?: WasmInitInput): Promise<boolean> {
  if (activeEngine) return true;
  try {
    const engine = await createLexelWasmEngine(input);
    bindEngine(engine);
    return true;
  } catch {
    return false;
  }
}

/** Synchronous initialization from in-memory WASM bytes (useful for Electron fs reads & tests). */
export function initObsidianLexelWasmSync(module: BufferSource | WebAssembly.Module): boolean {
  if (activeEngine) return true;
  try {
    initLexelWasmSync(module);
    bindEngine(new LexelWasmEngine());
    return true;
  } catch {
    return false;
  }
}

export function disposeObsidianLexelWasm(): void {
  registerObsidianWasmAdapter(null);
  activeEngine?.free();
  activeEngine = null;
}
