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
  type ObsidianLexelSettings,
  requestLocalDaemonRewrite,
  syncObsidianSettingsFromDesktop,
  toSentenceCase,
  toTitleCase,
} from './analyzer';

export default class LexelObsidianPlugin extends Plugin {
  settings: ObsidianLexelSettings = { ...DEFAULT_OBSIDIAN_SETTINGS };
  private statusBarEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    const saved = (await this.loadData()) as Partial<ObsidianLexelSettings> | null;
    this.settings = { ...DEFAULT_OBSIDIAN_SETTINGS, ...(saved ?? {}) };

    this.statusBarEl = this.addStatusBarItem();
    this.updateStatusBar();

    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.updateStatusBar()));
    this.registerEvent(this.app.workspace.on('editor-change', () => this.updateStatusBar()));

    this.addCommand({
      id: 'lexel-check-note',
      name: 'Lexel: Check Current Note (Zero AI)',
      editorCallback: (editor: Editor) => {
        const report = analyzeObsidianNote(editor.getValue(), this.settings.styleGuide);
        new Notice(
          `${report.statusBarLabel} (slop: ${report.slopCount}, invisible: ${report.invisibleCount}, structure: ${report.structureCount}, secrets: ${report.secretCount})`,
        );
      },
    });

    this.addCommand({
      id: 'lexel-fix-all-safe',
      name: 'Lexel: Fix All Safe Issues (No AI)',
      editorCallback: (editor: Editor) => {
        const original = editor.getValue();
        const fixed = applyObsidianSafeFix(original, this.settings.styleGuide);
        if (fixed.fixesApplied > 0 && fixed.text !== original) {
          editor.setValue(fixed.text);
          new Notice(`Lexel applied ${fixed.fixesApplied} deterministic fix(es).`);
        } else {
          new Notice('Lexel found no safe deterministic fixes to apply.');
        }
        this.updateStatusBar();
      },
    });

    this.addCommand({
      id: 'lexel-clean-typography',
      name: 'Lexel: Clean Quotes & Invisible Unicode',
      editorCallback: (editor: Editor) => {
        const original = editor.getValue();
        const norm = normalizeTypography(original);
        if (norm.fixesApplied > 0 && norm.text !== original) {
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

    this.addCommand({
      id: 'lexel-ai-deslop-selection',
      name: 'Lexel: Deslop Selection with Local AI (Lexel Desktop)',
      editorCallback: async (editor: Editor) => {
        const sel = editor.getSelection();
        const res = await requestLocalDaemonRewrite(this.settings, sel, 'deslop');
        if (!res.ok) {
          new Notice(res.error);
          return;
        }
        editor.replaceSelection(res.suggestion);
        new Notice('Applied local AI deslop rewrite.');
      },
    });

    this.addCommand({
      id: 'lexel-ai-fix-grammar-selection',
      name: 'Lexel: Fix Grammar & Flow with Local AI (Lexel Desktop)',
      editorCallback: async (editor: Editor) => {
        const sel = editor.getSelection();
        const res = await requestLocalDaemonRewrite(this.settings, sel, 'fix_grammar_flow');
        if (!res.ok) {
          new Notice(res.error);
          return;
        }
        editor.replaceSelection(res.suggestion);
        new Notice('Applied local AI grammar & flow rewrite.');
      },
    });

    this.addCommand({
      id: 'lexel-ai-shorten-selection',
      name: 'Lexel: Shorten Selection with Local AI (Lexel Desktop)',
      editorCallback: async (editor: Editor) => {
        const sel = editor.getSelection();
        const res = await requestLocalDaemonRewrite(this.settings, sel, 'shorten');
        if (!res.ok) {
          new Notice(res.error);
          return;
        }
        editor.replaceSelection(res.suggestion);
        new Notice('Applied local AI concise rewrite.');
      },
    });

    this.addCommand({
      id: 'lexel-sync-from-desktop',
      name: 'Lexel: Sync Rules & Style Guide from Lexel Desktop',
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

  private updateStatusBar(): void {
    if (!this.statusBarEl) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      this.statusBarEl.textContent = 'Lexel: ready';
      return;
    }
    const report = analyzeObsidianNote(view.editor.getValue(), this.settings.styleGuide);
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
      .setDesc('Loopback URL used for optional local AI rewrites (default http://127.0.0.1:42424).')
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
  }
}
