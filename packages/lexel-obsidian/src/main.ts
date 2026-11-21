import {
  type App,
  type Editor,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
} from 'obsidian';
import {
  analyzeObsidianNote,
  applyObsidianSafeFix,
  DEFAULT_OBSIDIAN_SETTINGS,
  normalizeTypography,
  type ObsidianAiTaskId,
  type ObsidianLexelSettings,
  requestLocalDaemonComplete,
  requestLocalDaemonDoctor,
  requestLocalDaemonRewrite,
  syncObsidianSettingsFromDesktop,
  toSentenceCase,
  toTitleCase,
} from './analyzer';
import { disposeObsidianLexelWasm, initObsidianLexelWasm } from './wasmLoader';

export default class LexelObsidianPlugin extends Plugin {
  settings: ObsidianLexelSettings = { ...DEFAULT_OBSIDIAN_SETTINGS };
  private statusBarEl: HTMLElement | null = null;
  private statusDebounceTimer: number | null = null;
  private lastUndoSnapshot: { previousText: string; expiresAt: number } | null = null;

  async onload(): Promise<void> {
    const saved = (await this.loadData()) as Partial<ObsidianLexelSettings> | null;
    this.settings = { ...DEFAULT_OBSIDIAN_SETTINGS, ...(saved ?? {}) };

    this.statusBarEl = this.addStatusBarItem();
    this.updateStatusBar();

    // Non-blocking zero-daemon `lexel-wasm` upgrade (falls back cleanly to TS Tier 0 if unavailable).
    void initObsidianLexelWasm()
      .then((ready) => {
        if (ready) this.updateStatusBar();
      })
      .catch(() => undefined);

    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.updateStatusBar()));
    this.registerEvent(
      this.app.workspace.on('editor-change', () => {
        if (this.statusDebounceTimer != null) {
          window.clearTimeout(this.statusDebounceTimer);
        }
        this.statusDebounceTimer = window.setTimeout(() => {
          this.statusDebounceTimer = null;
          this.updateStatusBar();
        }, 120);
      }),
    );

    this.addCommand({
      id: 'lexel-check-note',
      name: 'Lexel: Check Current Note (Slop Meter, Consistency & Guards)',
      editorCallback: (editor: Editor) => {
        const report = analyzeObsidianNote(editor.getValue(), this.settings.styleGuide, {
          customSlopTerms: this.settings.customSlopTerms,
          disabledSlopTerms: this.settings.disabledSlopTerms,
          crutchWords: this.settings.crutchWords,
        });
        new Notice(
          `${report.statusBarLabel} (${report.slopLabel}; slop: ${report.slopCount}, consistency: ${report.consistencyCount}, guards: ${report.guardCount}, secrets: ${report.secretCount})`,
          6000,
        );
      },
    });

    this.addCommand({
      id: 'lexel-fix-all-safe',
      name: 'Lexel: Fix All Safe Issues (Zero AI)',
      editorCallback: (editor: Editor) => {
        const original = editor.getValue();
        const fixed = applyObsidianSafeFix(original, this.settings.styleGuide, {
          customSlopTerms: this.settings.customSlopTerms,
          disabledSlopTerms: this.settings.disabledSlopTerms,
        });
        if (fixed.fixesApplied > 0 && fixed.text !== original) {
          this.lastUndoSnapshot = { previousText: original, expiresAt: Date.now() + 10_000 };
          editor.setValue(fixed.text);
          new Notice(
            `Lexel applied ${fixed.fixesApplied} deterministic fix(es). Run "Revert Last Lexel Edit" within 10s to undo.`,
            5000,
          );
        } else {
          new Notice('Lexel found no safe deterministic fixes to apply.');
        }
        this.updateStatusBar();
      },
    });

    this.addCommand({
      id: 'lexel-revert-last-edit',
      name: 'Lexel: Revert Last Lexel Edit (10s Undo)',
      editorCallback: (editor: Editor) => {
        if (!this.lastUndoSnapshot || Date.now() > this.lastUndoSnapshot.expiresAt) {
          new Notice('No recent Lexel edit to revert.');
          return;
        }
        editor.setValue(this.lastUndoSnapshot.previousText);
        this.lastUndoSnapshot = null;
        this.updateStatusBar();
        new Notice('Reverted to original text before Lexel edit.');
      },
    });

    this.addCommand({
      id: 'lexel-clean-typography',
      name: 'Lexel: Clean Quotes & Invisible Unicode',
      editorCallback: (editor: Editor) => {
        const original = editor.getValue();
        const norm = normalizeTypography(original);
        if (norm.fixesApplied > 0 && norm.text !== original) {
          this.lastUndoSnapshot = { previousText: original, expiresAt: Date.now() + 10_000 };
          editor.setValue(norm.text);
          new Notice(`Cleaned ${norm.fixesApplied} quote/invisible Unicode issue(s).`);
        } else {
          new Notice('Typography and Unicode are already clean.');
        }
      },
    });

    this.addCommand({
      id: 'lexel-title-case-selection',
      name: 'Lexel: Convert Selection to Title Case',
      editorCallback: (editor: Editor) => {
        const sel = editor.getSelection();
        if (!sel.trim()) {
          new Notice('Select a heading or line first.');
          return;
        }
        editor.replaceSelection(toTitleCase(sel));
      },
    });

    this.addCommand({
      id: 'lexel-sentence-case-selection',
      name: 'Lexel: Convert Selection to Sentence Case',
      editorCallback: (editor: Editor) => {
        const sel = editor.getSelection();
        if (!sel.trim()) {
          new Notice('Select a sentence or paragraph first.');
          return;
        }
        editor.replaceSelection(toSentenceCase(sel));
      },
    });

    const aiTasks: Array<{ id: string; name: string; task: ObsidianAiTaskId; label: string }> = [
      {
        id: 'lexel-ai-deslop-selection',
        name: 'Lexel: De-Slop Selection (Local AI)',
        task: 'deslop',
        label: 'de-slop',
      },
      {
        id: 'lexel-ai-fix-grammar-selection',
        name: 'Lexel: Fix Grammar & Flow (Local AI)',
        task: 'fix_grammar_flow',
        label: 'grammar & flow',
      },
      {
        id: 'lexel-ai-shorten-selection',
        name: 'Lexel: Shorten Selection (Local AI)',
        task: 'shorten',
        label: 'concise',
      },
      {
        id: 'lexel-ai-direct-selection',
        name: 'Lexel: Rewrite Direct (Local AI)',
        task: 'direct',
        label: 'direct',
      },
      {
        id: 'lexel-ai-softer-selection',
        name: 'Lexel: Rewrite Softer / Drop the Edge (Local AI)',
        task: 'softer',
        label: 'softer',
      },
      {
        id: 'lexel-ai-bluf-selection',
        name: 'Lexel: Lead with the Ask / BLUF (Local AI)',
        task: 'bluf',
        label: 'BLUF',
      },
      {
        id: 'lexel-ai-natural-english-selection',
        name: 'Lexel: Natural English Polish (Local AI)',
        task: 'natural_english',
        label: 'natural English',
      },
    ];

    for (const item of aiTasks) {
      this.addCommand({
        id: item.id,
        name: item.name,
        editorCallback: async (editor: Editor) => {
          const sel = editor.getSelection();
          const fullBefore = editor.getValue();
          const res = await requestLocalDaemonRewrite(this.settings, sel, item.task);
          if (!res.ok) {
            new Notice(res.error);
            return;
          }
          this.lastUndoSnapshot = { previousText: fullBefore, expiresAt: Date.now() + 10_000 };
          editor.replaceSelection(res.suggestion);
          const suffix = res.fastPath
            ? ' (Tier 0 fast path)'
            : res.retried
              ? ' (auto-repaired)'
              : '';
          new Notice(`Applied local ${item.label} rewrite${suffix}.`);
          this.updateStatusBar();
        },
      });
    }

    this.addCommand({
      id: 'lexel-ai-complete-cursor',
      name: 'Lexel: Complete Sentence at Cursor (Local AI)',
      editorCallback: async (editor: Editor) => {
        const cursor = editor.getCursor?.();
        const prefix =
          cursor && editor.getRange
            ? editor.getRange({ line: Math.max(0, cursor.line - 4), ch: 0 }, cursor)
            : editor.getValue();
        const fullBefore = editor.getValue();
        const res = await requestLocalDaemonComplete(this.settings, prefix);
        if (!res.ok) {
          new Notice(res.error);
          return;
        }
        if (!res.completion.trim()) {
          new Notice('Local model returned no completion for this context.');
          return;
        }
        this.lastUndoSnapshot = { previousText: fullBefore, expiresAt: Date.now() + 10_000 };
        if (cursor && editor.replaceRange) {
          editor.replaceRange(res.completion, cursor);
        } else {
          editor.replaceSelection(res.completion);
        }
        new Notice('Inserted local completion.');
      },
    });

    this.addCommand({
      id: 'lexel-doctor-check',
      name: 'Lexel: Local Privacy & Daemon Diagnostics',
      callback: async () => {
        const res = await requestLocalDaemonDoctor(this.settings);
        new Notice(res.ok ? res.summary : res.error, 6000);
      },
    });

    this.addCommand({
      id: 'lexel-sync-from-desktop',
      name: 'Lexel: Sync Rules, Crutch Words & Style Guide from Lexel Desktop',
      callback: async () => {
        const res = await syncObsidianSettingsFromDesktop(this.settings);
        if (!res.ok) {
          new Notice(res.error);
          return;
        }
        this.settings = res.next;
        await this.saveData(this.settings);
        this.updateStatusBar();
        new Notice(`Synced rules and style guide from Lexel Desktop (${res.profileName}).`);
      },
    });

    this.addSettingTab(new LexelSettingTab(this.app, this));
  }

  onunload(): void {
    if (this.statusDebounceTimer != null) {
      window.clearTimeout(this.statusDebounceTimer);
      this.statusDebounceTimer = null;
    }
    disposeObsidianLexelWasm();
  }

  private updateStatusBar(): void {
    if (!this.statusBarEl) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      this.statusBarEl.textContent = 'Lexel: ready · 0B sent';
      return;
    }
    const report = analyzeObsidianNote(view.editor.getValue(), this.settings.styleGuide, {
      customSlopTerms: this.settings.customSlopTerms,
      disabledSlopTerms: this.settings.disabledSlopTerms,
      crutchWords: this.settings.crutchWords,
    });
    this.statusBarEl.textContent = report.statusBarLabel;
  }
}

class LexelSettingTab extends PluginSettingTab {
  private readonly lexelPlugin: LexelObsidianPlugin;

  constructor(app: App, plugin: LexelObsidianPlugin) {
    super(app, plugin);
    this.lexelPlugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.innerHTML = '';

    new Setting(containerEl)
      .setName('Local lexel-daemon Endpoint')
      .setDesc(
        'Loopback-only URL for optional local AI rewrites (default http://127.0.0.1:42424). Zero bytes leave your device.',
      )
      .addText((text) =>
        text
          .setPlaceholder('http://127.0.0.1:42424')
          .setValue(this.lexelPlugin.settings.daemonEndpoint)
          .onChange(async (value) => {
            this.lexelPlugin.settings.daemonEndpoint = value.trim() || 'http://127.0.0.1:42424';
            await this.lexelPlugin.saveData(this.lexelPlugin.settings);
          }),
      );

    new Setting(containerEl)
      .setName('Local Daemon Bearer Token')
      .setDesc('Run `lexel-daemon token` in your terminal to authenticate local AI requests.')
      .addText((text) =>
        text
          .setPlaceholder('Paste local daemon.token')
          .setValue(this.lexelPlugin.settings.daemonToken)
          .onChange(async (value) => {
            this.lexelPlugin.settings.daemonToken = value.trim();
            await this.lexelPlugin.saveData(this.lexelPlugin.settings);
          }),
      );

    new Setting(containerEl)
      .setName('Secret Redact-and-Restore')
      .setDesc(
        'Swap detected tokens/PII for [LEXEL_REDACTED_n] before local AI inference and restore after (off = strict block).',
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.lexelPlugin.settings.redactSecrets === true)
          .onChange(async (value) => {
            this.lexelPlugin.settings.redactSecrets = value;
            await this.lexelPlugin.saveData(this.lexelPlugin.settings);
          }),
      );

    new Setting(containerEl)
      .setName('Local Ghost-Text Completion')
      .setDesc('Opt-in local sentence completion at cursor via lexel-daemon (POST /v1/complete).')
      .addToggle((toggle) =>
        toggle
          .setValue(this.lexelPlugin.settings.ghostTextEnabled === true)
          .onChange(async (value) => {
            this.lexelPlugin.settings.ghostTextEnabled = value;
            await this.lexelPlugin.saveData(this.lexelPlugin.settings);
          }),
      );

    new Setting(containerEl)
      .setName('Personal Crutch Words')
      .setDesc(
        'Comma-separated filler words to flag in your notes (e.g. just, actually, basically).',
      )
      .addText((text) =>
        text
          .setPlaceholder('just, actually, basically')
          .setValue((this.lexelPlugin.settings.crutchWords ?? []).join(', '))
          .onChange(async (value) => {
            this.lexelPlugin.settings.crutchWords = value
              .split(',')
              .map((w) => w.trim().toLowerCase())
              .filter(Boolean);
            await this.lexelPlugin.saveData(this.lexelPlugin.settings);
          }),
      );
  }
}
