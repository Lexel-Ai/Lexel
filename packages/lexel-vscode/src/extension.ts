import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';
import {
  type DiffGroundingMode,
  normalizeDiffGroundingMode,
  resolveLexelCliCommand,
  resolveLexelLsCommand,
  resolveSurfaceForDocument,
  STARTER_LEXEL_TOML,
  SUPPORTED_DOCUMENT_SELECTOR,
} from './lspConfig';

const execFileAsync = promisify(execFile);

let client: LanguageClient | undefined;
let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Lexel');
  }
  return outputChannel;
}

function buildClient(): LanguageClient {
  const cfg = vscode.workspace.getConfiguration('lexel');
  const { command, args } = resolveLexelLsCommand(cfg.get<string>('path'));

  const serverOptions: ServerOptions = {
    run: { command, args, transport: TransportKind.stdio },
    debug: { command, args, transport: TransportKind.stdio },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: SUPPORTED_DOCUMENT_SELECTOR,
    synchronize: {
      configurationSection: 'lexel',
    },
  };

  return new LanguageClient(
    'lexel-ls',
    'Lexel Local Writing Assistant',
    serverOptions,
    clientOptions,
  );
}

async function startClient(): Promise<void> {
  const enabled = vscode.workspace.getConfiguration('lexel').get<boolean>('enable', true);
  if (!enabled) return;
  client = buildClient();
  await client.start();
}

async function triggerAiCommand(
  task: string,
  surfaceOverride?: string,
  diffModeOverride?: DiffGroundingMode,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage('Open a document before running Lexel Local AI.');
    return;
  }
  const cfg = vscode.workspace.getConfiguration('lexel');
  const surfaceId =
    surfaceOverride ??
    resolveSurfaceForDocument(editor.document.languageId, editor.document.uri.fsPath);
  const diffMode =
    diffModeOverride ?? normalizeDiffGroundingMode(cfg.get<string>('diffGrounding', 'auto'));
  const baseBranch = cfg.get<string>('baseBranch', '').trim();

  await vscode.commands.executeCommand(
    'lexel.aiRewrite',
    editor.document.uri.toString(),
    task,
    surfaceId,
    diffMode,
    baseBranch,
  );
}

async function runLexelCli(
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cfg = vscode.workspace.getConfiguration('lexel');
  const bin = resolveLexelCliCommand(cfg.get<string>('cliPath'));
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      cwd,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const execErr = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    const exitCode = typeof execErr.code === 'number' ? execErr.code : 1;
    return {
      stdout: execErr.stdout ?? '',
      stderr: execErr.stderr ?? execErr.message ?? 'Failed to execute lexel CLI.',
      exitCode,
    };
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(
    vscode.commands.registerCommand('lexel.restartServer', async () => {
      if (client) {
        await client.stop();
        client = undefined;
      }
      await startClient();
      void vscode.window.showInformationMessage('Lexel language server restarted.');
    }),
    vscode.commands.registerCommand('lexel.fixAllSafe', async () => {
      await vscode.commands.executeCommand('editor.action.sourceAction', {
        kind: 'source.fixAll',
        apply: 'first',
      });
    }),
    vscode.commands.registerCommand('lexel.deslopDocument', async () => {
      await triggerAiCommand('deslop');
    }),
    vscode.commands.registerCommand('lexel.fixGrammarFlow', async () => {
      await triggerAiCommand('fix_grammar_flow');
    }),
    vscode.commands.registerCommand('lexel.shortenDocument', async () => {
      await triggerAiCommand('shorten');
    }),
    vscode.commands.registerCommand('lexel.polishCommit', async () => {
      await triggerAiCommand('rewrite_surface', 'ide_git_commit', 'staged');
    }),
    vscode.commands.registerCommand('lexel.polishPr', async () => {
      await triggerAiCommand('rewrite_surface', 'web_github_pr', 'branch');
    }),
    vscode.commands.registerCommand('lexel.runDoctor', async () => {
      const channel = getOutputChannel();
      channel.clear();
      channel.show(true);
      channel.appendLine('Running `lexel doctor`...');
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const res = await runLexelCli(['doctor'], cwd);
      if (res.stdout) channel.appendLine(res.stdout.trimEnd());
      if (res.stderr) channel.appendLine(res.stderr.trimEnd());
    }),
    vscode.commands.registerCommand('lexel.checkWorkspaceCi', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== 'file') {
        void vscode.window.showWarningMessage(
          'Save and focus a file before running Lexel CI check.',
        );
        return;
      }
      const cfg = vscode.workspace.getConfiguration('lexel');
      const args = ['check', '--ci'];
      if (!cfg.get<boolean>('useRepoConfig', true)) {
        args.push('--no-repo-config');
      }
      args.push(editor.document.uri.fsPath);
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const channel = getOutputChannel();
      channel.clear();
      channel.show(true);
      const res = await runLexelCli(args, cwd);
      if (res.stdout) channel.appendLine(res.stdout.trimEnd());
      if (res.stderr) channel.appendLine(res.stderr.trimEnd());
      if (res.exitCode === 0) {
        void vscode.window.showInformationMessage('Lexel CI check passed.');
      } else {
        void vscode.window.showWarningMessage(
          'Lexel CI check reported findings. See the Lexel output channel.',
        );
      }
    }),
    vscode.commands.registerCommand('lexel.initRepoConfig', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        void vscode.window.showWarningMessage(
          'Open a workspace folder first to create .lexel.toml.',
        );
        return;
      }
      const target = path.join(folder.uri.fsPath, '.lexel.toml');
      try {
        await fs.access(target);
        const doc = await vscode.workspace.openTextDocument(target);
        await vscode.window.showTextDocument(doc);
        void vscode.window.showInformationMessage(
          '.lexel.toml already exists; opened existing file.',
        );
        return;
      } catch {
        // File does not exist yet; create it below.
      }
      await fs.writeFile(target, STARTER_LEXEL_TOML, 'utf8');
      const doc = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(doc);
      void vscode.window.showInformationMessage('Created .lexel.toml in workspace root.');
    }),
    vscode.commands.registerCommand('lexel.importGitVoice', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        void vscode.window.showWarningMessage(
          'Open a Git workspace folder before importing commit voice.',
        );
        return;
      }
      const author = await vscode.window.showInputBox({
        prompt: 'Optional Git author name or email filter (leave blank for all commits)',
        placeHolder: 'Your Name',
      });
      if (author === undefined) return;
      const args = ['voice', 'import', '--git-log', '--repo', folder.uri.fsPath];
      if (author.trim()) {
        args.push('--author', author.trim());
      }
      const channel = getOutputChannel();
      channel.clear();
      channel.show(true);
      const res = await runLexelCli(args, folder.uri.fsPath);
      if (res.stdout) channel.appendLine(res.stdout.trimEnd());
      if (res.stderr) channel.appendLine(res.stderr.trimEnd());
      if (res.exitCode === 0) {
        void vscode.window.showInformationMessage(
          'Imported Git commits into local Lexel voice memory.',
        );
      } else {
        void vscode.window.showWarningMessage(
          'Lexel voice import failed. See the Lexel output channel.',
        );
      }
    }),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration('lexel.enable') || event.affectsConfiguration('lexel.path')) {
        if (client) {
          await client.stop();
          client = undefined;
        }
        await startClient();
      }
    }),
  );

  await startClient();
}

export async function deactivate(): Promise<void> {
  if (client) {
    await client.stop();
    client = undefined;
  }
  if (outputChannel) {
    outputChannel.dispose();
    outputChannel = undefined;
  }
}
