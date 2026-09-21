import * as vscode from 'vscode';
import { StalkerDefinitionProvider } from './definitionProvider';
import { SymbolIndex } from './symbolIndex';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const index = new SymbolIndex();

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: 'Indexing STALKER 2 CFG SIDs...'
    },
    () => index.rebuild()
  );

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      { language: 'stalker2-cfg', scheme: 'file' },
      new StalkerDefinitionProvider(index)
    )
  );

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.cfg');

  watcher.onDidCreate((uri) => index.indexFile(uri), undefined, context.subscriptions);
  watcher.onDidChange((uri) => index.indexFile(uri), undefined, context.subscriptions);
  watcher.onDidDelete(() => index.rebuild(), undefined, context.subscriptions);

  context.subscriptions.push(watcher);
}

export function deactivate(): void {}
