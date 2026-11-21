declare module 'obsidian' {
  export class App {
    workspace: {
      on(name: string, callback: () => void): unknown;
      getActiveViewOfType<T>(type: new (...args: never[]) => T): T | null;
    };
  }

  export interface EditorPosition {
    line: number;
    ch: number;
  }

  export interface Editor {
    getValue(): string;
    setValue(text: string): void;
    getSelection(): string;
    replaceSelection(replacement: string): void;
    getCursor?(): EditorPosition;
    getRange?(from: EditorPosition, to: EditorPosition): string;
    replaceRange?(replacement: string, from: EditorPosition, to?: EditorPosition): void;
  }

  export class MarkdownView {
    editor: Editor;
  }

  export class Notice {
    constructor(message: string, timeout?: number);
  }

  export class Setting {
    constructor(containerEl: HTMLElement);
    setName(name: string): this;
    setDesc(desc: string): this;
    addText(cb: (text: TextComponent) => void): this;
    addToggle(cb: (toggle: ToggleComponent) => void): this;
  }

  export interface TextComponent {
    setPlaceholder(placeholder: string): this;
    setValue(value: string): this;
    onChange(cb: (value: string) => unknown): this;
  }

  export interface ToggleComponent {
    setValue(value: boolean): this;
    onChange(cb: (value: boolean) => unknown): this;
  }

  export abstract class PluginSettingTab {
    app: App;
    plugin: Plugin;
    containerEl: HTMLElement;
    constructor(app: App, plugin: Plugin);
    abstract display(): void;
  }

  export abstract class Plugin {
    app: App;
    loadData(): Promise<unknown>;
    saveData(data: unknown): Promise<void>;
    addStatusBarItem(): HTMLElement;
    addCommand(cmd: {
      id: string;
      name: string;
      callback?: () => void | Promise<void>;
      editorCallback?: (editor: Editor) => void | Promise<void>;
    }): void;
    addSettingTab(tab: PluginSettingTab): void;
    registerEvent(eventRef: unknown): void;
    abstract onload(): Promise<void> | void;
    onunload?(): void;
  }
}
