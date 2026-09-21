import * as vscode from 'vscode';
import { StalkerDefinitionProvider } from './definitionProvider';
import { StalkerHoverProvider } from './hoverProvider';
import { SymbolIndex } from './symbolIndex';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('STALKER 2 CFG Tools');
  context.subscriptions.push(output);

  output.appendLine('STALKER 2 CFG Tools');
  output.appendLine('Extension activated.');

  const folders = vscode.workspace.workspaceFolders ?? [];
  output.appendLine('Workspace: ' + (folders.map((folder) => folder.name).join(', ') || '<none>'));
  output.appendLine('');

  const index = new SymbolIndex(output);
  const selector: vscode.DocumentSelector = { language: 'stalker2-cfg', scheme: 'file' };

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(selector, new StalkerDefinitionProvider(index)),
    vscode.languages.registerHoverProvider(selector, new StalkerHoverProvider(index))
  );

  let rebuildInProgress: Promise<void> | undefined;

  const rebuildIndex = (): Promise<void> => {
    if (rebuildInProgress) return rebuildInProgress;

    output.appendLine('');
    output.appendLine('Starting index rebuild...');
    rebuildInProgress = index.rebuild()
      .then(() => undefined)
      .catch((error) => {
        output.appendLine('INDEX ERROR: ' + String(error));
        console.error('STALKER 2 CFG Tools index error', error);
      })
      .finally(() => {
        rebuildInProgress = undefined;
      });

    return rebuildInProgress;
  };

  // Do not block extension activation on a large VanillaReference tree.
  void rebuildIndex();

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.cfg');
  watcher.onDidCreate((uri) => void index.indexFile(uri), undefined, context.subscriptions);
  watcher.onDidChange((uri) => void index.indexFile(uri), undefined, context.subscriptions);
  watcher.onDidDelete(() => void rebuildIndex(), undefined, context.subscriptions);

  context.subscriptions.push(
    watcher,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('stalker2Cfg.referencePaths')) void rebuildIndex();
    })
  );
}

export function deactivate(): void {}
