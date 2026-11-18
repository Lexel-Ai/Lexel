import {
  createBinaryModuleFromUrl,
  type Dialect,
  type LintConfig,
  LocalLinter,
  type StructuredLintConfig,
  type Summary,
  type WeirpackTestFailures,
} from 'harper.js';
import { type UnpackedLintGroups, unpackLint } from 'lint-framework';
import type { LintLanguage, StoredWeirpack, SurfaceId, SurfaceProfile } from './types';
import { scanTier0Diagnostics } from './verifier';

export interface LabLintResult {
  lints: UnpackedLintGroups;
  grammarCount: number;
  slopCount: number;
  surfaceCount: number;
  secretCount: number;
  latencyMs: number;
}

export interface TextStats {
  chars: number;
  words: number;
  sentences: number;
}

export interface WritingMetrics extends TextStats {
  readingTimeSec: number;
  slopDensity: number;
  secretCount: number;
}

export function computeTextStats(text: string): TextStats {
  const trimmed = text.trim();
  if (!trimmed) return { chars: text.length, words: 0, sentences: 0 };
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  const sentences = trimmed.split(/[.!?]+/).filter((s) => s.trim().length > 0).length;
  return { chars: text.length, words, sentences };
}

export function computeWritingMetrics(
  text: string,
  counts?: { slopCount?: number; secretCount?: number },
): WritingMetrics {
  const base = computeTextStats(text);
  const readingTimeSec = base.words > 0 ? Math.max(1, Math.round((base.words / 200) * 60)) : 0;
  const slopCount = counts?.slopCount ?? 0;
  const slopDensity = base.words > 0 ? Math.round((slopCount / base.words) * 1000) / 10 : 0;
  return {
    ...base,
    readingTimeSec,
    slopDensity,
    secretCount: counts?.secretCount ?? 0,
  };
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

export class LexelLabEngine {
  private linter: LocalLinter | null = null;
  private initPromise: Promise<LocalLinter> | null = null;
  private currentDialect: Dialect | null = null;
  private currentWeirpackSig = '';

  public async init(params: {
    dialect: Dialect;
    lintConfig: LintConfig;
    userDictionary: string[];
    ignoredLints: string;
    weirpacks?: StoredWeirpack[];
  }): Promise<LocalLinter> {
    const weirpackSig = (params.weirpacks ?? [])
      .filter((p) => p.enabled)
      .map((p) => `${p.name}:${p.bytesBase64.length}`)
      .join('|');

    if (
      this.linter &&
      this.currentDialect === params.dialect &&
      this.currentWeirpackSig === weirpackSig
    ) {
      return this.linter;
    }
    if (
      this.initPromise &&
      this.currentDialect === params.dialect &&
      this.currentWeirpackSig === weirpackSig
    ) {
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
      for (const pack of params.weirpacks ?? []) {
        if (!pack.enabled) continue;
        try {
          await instance.loadWeirpackFromBytes(base64ToUint8Array(pack.bytesBase64));
        } catch {
          // Skip corrupted pack entries during initialization
        }
      }
      this.currentDialect = params.dialect;
      this.currentWeirpackSig = weirpackSig;
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
      languageMode?: LintLanguage;
      isolateEnglish: boolean;
      lintConfig: LintConfig;
      userDictionary: string[];
      ignoredLints: string;
      customSlopTerms?: string[];
      disabledSlopTerms?: string[];
      customSurfaces?: SurfaceProfile[];
      weirpacks?: StoredWeirpack[];
    },
  ): Promise<LabLintResult> {
    const started = performance.now();
    if (!text.trim()) {
      return {
        lints: {},
        grammarCount: 0,
        slopCount: 0,
        surfaceCount: 0,
        secretCount: 0,
        latencyMs: 0,
      };
    }

    const instance = await this.init({
      dialect: params.dialect,
      lintConfig: params.lintConfig,
      userDictionary: params.userDictionary,
      ignoredLints: params.ignoredLints,
      weirpacks: params.weirpacks,
    });

    const grouped = await instance.organizedLints(text, {
      isolateEnglish: params.isolateEnglish,
      language: params.languageMode ?? 'plaintext',
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
    const { slopLints, surfaceLints, secretLints } = scanTier0Diagnostics(text, params.surfaceId, {
      customSlopTerms: params.customSlopTerms,
      disabledSlopTerms: params.disabledSlopTerms,
      customSurfaces: params.customSurfaces,
    });

    if (secretLints.length > 0) {
      bySource.LexelSecrets = secretLints;
    }
    if (slopLints.length > 0) {
      bySource.LexelAntiSlop = slopLints;
    }
    if (surfaceLints.length > 0) {
      bySource.LexelSurface = surfaceLints;
    }

    const grammarCount = Object.entries(bySource)
      .filter(
        ([k]) => k !== 'LexelAntiSlop' && k !== 'LexelSurface' && k !== 'LexelSecrets',
      )
      .reduce((acc, [, list]) => acc + list.length, 0);

    return {
      lints: bySource,
      grammarCount,
      slopCount: slopLints.length,
      surfaceCount: surfaceLints.length,
      secretCount: secretLints.length,
      latencyMs: Math.round((performance.now() - started) * 10) / 10,
    };
  }

  public async getFullConfigAndDescriptions(): Promise<{
    config: LintConfig;
    defaultConfig: LintConfig;
    structuredConfig: StructuredLintConfig;
    descriptions: Record<string, string>;
  }> {
    if (!this.linter) {
      throw new Error('Linter not initialized yet.');
    }
    const [config, defaultConfig, structuredConfig, descriptions] = await Promise.all([
      this.linter.getLintConfig(),
      this.linter.getDefaultLintConfig(),
      this.linter.getStructuredLintConfig(),
      this.linter.getLintDescriptionsHTML(),
    ]);
    return { config, defaultConfig, structuredConfig, descriptions };
  }

  public async setLintConfig(config: LintConfig): Promise<void> {
    if (!this.linter) return;
    await this.linter.setLintConfig(config);
  }

  public async toTitleCase(text: string): Promise<string> {
    if (!this.linter) return text;
    return this.linter.toTitleCase(text);
  }

  public async loadWeirpackBytes(bytes: Uint8Array): Promise<WeirpackTestFailures | undefined> {
    if (!this.linter) {
      throw new Error('Linter not initialized yet.');
    }
    return this.linter.loadWeirpackFromBytes(bytes);
  }

  public async summarizeStats(): Promise<Summary | null> {
    if (!this.linter) return null;
    return this.linter.summarizeStats();
  }

  public async exportStatsFile(): Promise<string> {
    if (!this.linter) return '';
    return this.linter.generateStatsFile();
  }

  public async importStatsFile(statsFile: string): Promise<void> {
    if (!this.linter || !statsFile.trim()) return;
    await this.linter.importStatsFile(statsFile);
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
    this.currentWeirpackSig = '';
  }
}
