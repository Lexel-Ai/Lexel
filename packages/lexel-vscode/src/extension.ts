import * as vscode from 'vscode';
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';
import { resolveLexelLsCommand, SUPPORTED_DOCUMENT_SELECTOR } from './lspConfig';

let client: LanguageClient | undefined;

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
}
