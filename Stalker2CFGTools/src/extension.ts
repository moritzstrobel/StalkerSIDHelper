import * as vscode from 'vscode';
import { StalkerDefinitionProvider } from './definitionProvider';
import { StalkerHoverProvider } from './hoverProvider';
import { SymbolIndex } from './symbolIndex';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const index = new SymbolIndex();

  const rebuildIndex = async (): Promise<void> => {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: 'Indexing STALKER 2 CFG SIDs...'
      },
      () => index.rebuild()
    );
  };

  await rebuildIndex();

  const selector: vscode.DocumentSelector = { language: 'stalker2-cfg', scheme: 'file' };

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      selector,
      new StalkerDefinitionProvider(index)
    ),
    vscode.languages.registerHoverProvider(
      selector,
      new StalkerHoverProvider(index)
    )
  );

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.cfg');

  watcher.onDidCreate((uri) => index.indexFile(uri), undefined, context.subscriptions);
  watcher.onDidChange((uri) => index.indexFile(uri), undefined, context.subscriptions);
  watcher.onDidDelete(() => rebuildIndex(), undefined, context.subscriptions);

  context.subscriptions.push(
    watcher,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('stalker2Cfg.referencePaths')) {
        void rebuildIndex();
      }
    })
  );
}

export function deactivate(): void {}
