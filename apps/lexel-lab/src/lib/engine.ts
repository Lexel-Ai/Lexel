import {
  createBinaryModuleFromUrl,
  type Dialect,
  type LintConfig,
  LocalLinter,
} from 'harper.js';
import { type UnpackedLintGroups, unpackLint } from 'lint-framework';
import type { SurfaceId } from './types';
import { scanTier0Diagnostics } from './verifier';

export interface LabLintResult {
  lints: UnpackedLintGroups;
  grammarCount: number;
  slopCount: number;
  surfaceCount: number;
  latencyMs: number;
}

export interface TextStats {
  chars: number;
  words: number;
  sentences: number;
}

export function computeTextStats(text: string): TextStats {
  const trimmed = text.trim();
  if (!trimmed) return { chars: text.length, words: 0, sentences: 0 };
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  const sentences = trimmed.split(/[.!?]+/).filter((s) => s.trim().length > 0).length;
  return { chars: text.length, words, sentences };
}

export class LexelLabEngine {
  private linter: LocalLinter | null = null;
  private initPromise: Promise<LocalLinter> | null = null;
  private currentDialect: Dialect | null = null;

  public async init(params: {
    dialect: Dialect;
    lintConfig: LintConfig;
    userDictionary: string[];
    ignoredLints: string;
  }): Promise<LocalLinter> {
    if (this.linter && this.currentDialect === params.dialect) {
      return this.linter;
    }
    if (this.initPromise && this.currentDialect === params.dialect) {
      return this.initPromise;
    }

    const run = async () => {
      if (this.linter) {
        this.linter.dispose();
        this.linter = null;
      }
      const wasmUrl = new URL('./wasm/harper_wasm_bg.wasm', window.location.href).href;
      const instance = new LocalLinter({
        binary: createBinaryModuleFromUrl(wasmUrl),
        dialect: params.dialect,
      });
      await instance.setup();

      if (params.ignoredLints) {
        await instance.importIgnoredLints(params.ignoredLints);
      }
      if (params.userDictionary.length > 0) {
        await instance.importWords(params.userDictionary);
      }
      if (Object.keys(params.lintConfig).length > 0) {
        await instance.setLintConfig(params.lintConfig);
      }
      this.currentDialect = params.dialect;
      this.linter = instance;
      return instance;
    };

    this.initPromise = run().finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  public async lint(
    text: string,
    params: {
      surfaceId: SurfaceId;
      dialect: Dialect;
      isolateEnglish: boolean;
      lintConfig: LintConfig;
      userDictionary: string[];
      ignoredLints: string;
    },
  ): Promise<LabLintResult> {
    const started = performance.now();
    if (!text.trim()) {
      return {
        lints: {},
        grammarCount: 0,
        slopCount: 0,
        surfaceCount: 0,
        latencyMs: 0,
      };
    }

    const instance = await this.init({
      dialect: params.dialect,
      lintConfig: params.lintConfig,
      userDictionary: params.userDictionary,
      ignoredLints: params.ignoredLints,
    });

    const grouped = await instance.organizedLints(text, {
      isolateEnglish: params.isolateEnglish,
    });

    const unpackedEntries = await Promise.all(
      Object.entries(grouped).map(async ([source, lints]) => {
        const unpacked = await Promise.all(lints.map((lint) => unpackLint(text, lint, instance)));
        for (const l of lints) {
          l.free();
        }
        return [source, unpacked] as const;
      }),
    );

    const bySource = Object.fromEntries(unpackedEntries) as UnpackedLintGroups;
    const { slopLints, surfaceLints } = scanTier0Diagnostics(text, params.surfaceId);

    if (slopLints.length > 0) {
      bySource.LexelAntiSlop = slopLints;
    }
    if (surfaceLints.length > 0) {
      bySource.LexelSurface = surfaceLints;
    }

    const grammarCount = Object.entries(bySource)
      .filter(([k]) => k !== 'LexelAntiSlop' && k !== 'LexelSurface')
      .reduce((acc, [, list]) => acc + list.length, 0);

    return {
      lints: bySource,
      grammarCount,
      slopCount: slopLints.length,
      surfaceCount: surfaceLints.length,
      latencyMs: Math.round((performance.now() - started) * 10) / 10,
    };
  }

  public async getFullConfigAndDescriptions(): Promise<{
    config: LintConfig;
    defaultConfig: LintConfig;
    descriptions: Record<string, string>;
  }> {
    if (!this.linter) {
      throw new Error('Linter not initialized yet.');
    }
    const [config, defaultConfig, descriptions] = await Promise.all([
      this.linter.getLintConfig(),
      this.linter.getDefaultLintConfig(),
      this.linter.getLintDescriptionsHTML(),
    ]);
    return { config, defaultConfig, descriptions };
  }

  public async setLintConfig(config: LintConfig): Promise<void> {
    if (!this.linter) return;
    await this.linter.setLintConfig(config);
  }

  public async ignoreLintHash(hash: string): Promise<string> {
    if (!this.linter || !/^\d+$/.test(hash)) return '';
    await this.linter.ignoreLintHash(BigInt(hash));
    return this.linter.exportIgnoredLints();
  }

  public async clearIgnoredLints(): Promise<string> {
    if (!this.linter) return '';
    await this.linter.clearIgnoredLints();
    return this.linter.exportIgnoredLints();
  }

  public async importWords(words: string[]): Promise<void> {
    if (!this.linter || words.length === 0) return;
    await this.linter.importWords(words);
  }

  public dispose(): void {
    this.linter?.dispose();
    this.linter = null;
    this.currentDialect = null;
  }
}
