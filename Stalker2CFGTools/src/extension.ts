import * as vscode from 'vscode';
import { StalkerDefinitionProvider } from './definitionProvider';
import { StalkerHoverProvider } from './hoverProvider';
import { StalkerReferenceProvider } from './referenceProvider';
import { SymbolIndex } from './symbolIndex';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('STALKER 2 CFG Tools');
  context.subscriptions.push(output);

  output.appendLine('STALKER 2 CFG Tools');

  const folders = vscode.workspace.workspaceFolders ?? [];
  output.appendLine('Workspace: ' + (folders.map((folder) => folder.name).join(', ') || '<none>'));

  const index = new SymbolIndex(output);
  const selector: vscode.DocumentSelector = { language: 'stalker2-cfg', scheme: 'file' };

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(selector, new StalkerDefinitionProvider(index)),
    vscode.languages.registerHoverProvider(selector, new StalkerHoverProvider(index)),
    vscode.languages.registerReferenceProvider(selector, new StalkerReferenceProvider(index))
  );

  let rebuildInProgress: Promise<void> | undefined;

  const indexingEnabled = (): boolean =>
    vscode.workspace.getConfiguration('stalker2Cfg').get<boolean>('enableIndexing', true);

  const rebuildIndex = (): Promise<void> => {
    if (!indexingEnabled()) {
      return Promise.resolve();
    }
    if (rebuildInProgress) {
      return rebuildInProgress;
    }

    output.appendLine('Rebuilding CFG index...');
    const rebuild = index.rebuild()
      .then(() => undefined)
      .catch((error) => {
        output.appendLine('INDEX ERROR: ' + String(error));
        if (error instanceof Error && error.stack) output.appendLine(error.stack);
        console.error('STALKER 2 CFG Tools index error', error);
      })
      .finally(() => {
        if (rebuildInProgress === rebuild) rebuildInProgress = undefined;
      });

    rebuildInProgress = rebuild;
    return rebuild;
  };

  if (indexingEnabled()) {
    void rebuildIndex();
  } else {
    output.appendLine('Initial indexing DISABLED by setting.');
  }

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.cfg');
  watcher.onDidCreate((uri) => {
    if (indexingEnabled()) void index.indexFile(uri);
  }, undefined, context.subscriptions);
  watcher.onDidChange((uri) => {
    if (indexingEnabled()) void index.indexFile(uri);
  }, undefined, context.subscriptions);
  watcher.onDidDelete(() => {
    if (indexingEnabled()) void rebuildIndex();
  }, undefined, context.subscriptions);

  context.subscriptions.push(
    watcher,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('stalker2Cfg.enableIndexing')) {
        output.appendLine('Configuration changed: enableIndexing=' + indexingEnabled());
        if (indexingEnabled()) void rebuildIndex();
        else index.clear();
      } else if (event.affectsConfiguration('stalker2Cfg.vanillaReferencePath')) {
        void rebuildIndex();
      }
    })
  );

}

export function deactivate(): void {}
