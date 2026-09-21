import * as vscode from 'vscode';
import { StalkerDefinitionProvider } from './definitionProvider';
import { StalkerHoverProvider } from './hoverProvider';
import { SymbolIndex } from './symbolIndex';

function memory(): string {
  const usage = process.memoryUsage();
  const mb = (value: number) => (value / 1024 / 1024).toFixed(1) + ' MB';
  return 'rss=' + mb(usage.rss) + ', heapUsed=' + mb(usage.heapUsed) + ', heapTotal=' + mb(usage.heapTotal);
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('STALKER 2 CFG Tools');
  context.subscriptions.push(output);

  output.appendLine('STALKER 2 CFG Tools');
  output.appendLine('activate() entered. ' + memory());

  const onUnhandledRejection = (reason: unknown) => {
    output.appendLine('UNHANDLED REJECTION: ' + String(reason));
    console.error('STALKER 2 CFG Tools unhandled rejection', reason);
  };
  const onUncaughtException = (error: Error) => {
    output.appendLine('UNCAUGHT EXCEPTION: ' + String(error));
    if (error.stack) output.appendLine(error.stack);
    console.error('STALKER 2 CFG Tools uncaught exception', error);
  };
  process.on('unhandledRejection', onUnhandledRejection);
  process.on('uncaughtException', onUncaughtException);
  context.subscriptions.push({
    dispose: () => {
      process.off('unhandledRejection', onUnhandledRejection);
      process.off('uncaughtException', onUncaughtException);
    }
  });

  const folders = vscode.workspace.workspaceFolders ?? [];
  output.appendLine('Workspace: ' + (folders.map((folder) => folder.name).join(', ') || '<none>'));

  const index = new SymbolIndex(output);
  const selector: vscode.DocumentSelector = { language: 'stalker2-cfg', scheme: 'file' };

  output.appendLine('Registering definition and hover providers...');
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(selector, new StalkerDefinitionProvider(index)),
    vscode.languages.registerHoverProvider(selector, new StalkerHoverProvider(index))
  );
  output.appendLine('Providers registered. ' + memory());

  let rebuildInProgress: Promise<void> | undefined;

  const indexingEnabled = (): boolean =>
    vscode.workspace.getConfiguration('stalker2Cfg').get<boolean>('enableIndexing', true);

  const rebuildIndex = (): Promise<void> => {
    if (!indexingEnabled()) {
      output.appendLine('Index rebuild skipped: stalker2Cfg.enableIndexing=false');
      return Promise.resolve();
    }
    if (rebuildInProgress) {
      output.appendLine('Index rebuild already running; reusing current rebuild.');
      return rebuildInProgress;
    }

    output.appendLine('');
    output.appendLine('Starting index rebuild... ' + memory());
    rebuildInProgress = index.rebuild()
      .then(() => {
        output.appendLine('Index rebuild promise resolved. ' + memory());
      })
      .catch((error) => {
        output.appendLine('INDEX ERROR: ' + String(error));
        if (error instanceof Error && error.stack) output.appendLine(error.stack);
        console.error('STALKER 2 CFG Tools index error', error);
      })
      .finally(() => {
        rebuildInProgress = undefined;
      });

    return rebuildInProgress;
  };

  if (indexingEnabled()) {
    output.appendLine('Initial indexing enabled; scheduling rebuild.');
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
  output.appendLine('CFG watcher registered.');

  context.subscriptions.push(
    watcher,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('stalker2Cfg.enableIndexing')) {
        output.appendLine('Configuration changed: enableIndexing=' + indexingEnabled());
        if (indexingEnabled()) void rebuildIndex();
        else index.clear();
      } else if (event.affectsConfiguration('stalker2Cfg.referencePaths')) {
        void rebuildIndex();
      }
    })
  );

  output.appendLine('activate() completed. ' + memory());
}

export function deactivate(): void {}
