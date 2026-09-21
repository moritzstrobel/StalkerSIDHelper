import * as vscode from 'vscode';
import { DefinitionKind, SidDefinition } from './types';

const STRUCT_DEFINITION = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*struct\.begin\b/;
const SID_ASSIGNMENT = /^\s*SID\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\b/;
const decoder = new TextDecoder('utf-8');

export interface IndexStats {
  files: number;
  symbols: number;
  definitions: number;
  durationMs: number;
}

export class SymbolIndex {
  private readonly definitions = new Map<string, SidDefinition[]>();
  private output?: vscode.OutputChannel;

  constructor(output?: vscode.OutputChannel) {
    this.output = output;
  }

  clear(): void {
    this.definitions.clear();
  }

  async rebuild(): Promise<IndexStats> {
    const started = Date.now();
    this.clear();
    this.output?.appendLine('Discovering CFG files... ' + this.memory());

    const files = await vscode.workspace.findFiles('**/*.cfg', '**/{node_modules,.git,out,dist}/**');
    this.output?.appendLine('Found ' + files.length + ' CFG files. ' + this.memory());

    const batchSize = 25;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      await Promise.all(batch.map((uri) => this.indexFile(uri)));
      this.output?.appendLine('Indexed ' + Math.min(i + batch.length, files.length) + '/' + files.length + ' ' + this.memory());
    }

    const definitions = Array.from(this.definitions.values()).reduce((sum, entries) => sum + entries.length, 0);
    const stats = {
      files: files.length,
      symbols: this.definitions.size,
      definitions,
      durationMs: Date.now() - started
    };

    this.output?.appendLine('Symbols: ' + stats.symbols);
    this.output?.appendLine('Definitions: ' + stats.definitions);
    this.output?.appendLine('Index completed in ' + stats.durationMs + ' ms.');
    this.output?.appendLine('Index ready.');
    return stats;
  }

  async indexFile(uri: vscode.Uri): Promise<void> {
    this.removeFile(uri);

    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch (error) {
      this.output?.appendLine('ERROR reading ' + uri.fsPath + ': ' + String(error));
      console.warn('STALKER 2 CFG Tools: failed to read ' + uri.fsPath, error);
      return;
    }

    const text = decoder.decode(bytes);
    const lines = text.split(/\r?\n/);

    for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
      const line = lines[lineNumber];
      const structMatch = line.match(STRUCT_DEFINITION);
      if (structMatch) this.add(structMatch[1], uri, lineNumber, line.indexOf(structMatch[1]), 'struct');

      const sidMatch = line.match(SID_ASSIGNMENT);
      if (sidMatch) this.add(sidMatch[1], uri, lineNumber, line.indexOf(sidMatch[1]), 'sid');
    }
  }

  find(sid: string, sourceUri?: vscode.Uri): SidDefinition[] {
    const definitions = [...(this.definitions.get(sid) ?? [])];
    return definitions.sort((a, b) => {
      const referenceDifference = Number(b.isReference) - Number(a.isReference);
      if (referenceDifference !== 0) return referenceDifference;

      if (sourceUri) {
        const source = sourceUri.toString();
        const aLocal = a.uri.toString() === source ? 1 : 0;
        const bLocal = b.uri.toString() === source ? 1 : 0;
        if (aLocal !== bLocal) return bLocal - aLocal;
      }

      const kindDifference = this.kindPriority(a.kind) - this.kindPriority(b.kind);
      if (kindDifference !== 0) return kindDifference;

      return a.uri.fsPath.localeCompare(b.uri.fsPath) || a.range.start.line - b.range.start.line;
    });
  }

  private add(sid: string, uri: vscode.Uri, line: number, character: number, kind: DefinitionKind): void {
    const range = new vscode.Range(new vscode.Position(line, character), new vscode.Position(line, character + sid.length));
    const entries = this.definitions.get(sid) ?? [];
    entries.push({ sid, uri, range, kind, isReference: this.isReferencePath(uri) });
    this.definitions.set(sid, entries);
  }

  private isReferencePath(uri: vscode.Uri): boolean {
    const configuredPaths = vscode.workspace.getConfiguration('stalker2Cfg').get<string[]>('referencePaths', []);
    if (!vscode.workspace.getWorkspaceFolder(uri)) return false;

    const relativePath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/').toLowerCase();
    return configuredPaths.some((configuredPath) => {
      const normalized = configuredPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '').toLowerCase();
      return relativePath === normalized || relativePath.startsWith(normalized + '/');
    });
  }

  private memory(): string {
    const usage = process.memoryUsage();
        const mb = (value: number) => (value / 1024 / 1024).toFixed(1) + ' MB';
            return '[rss=' + mb(usage.rss) + ', heapUsed=' + mb(usage.heapUsed) + ']';
            }
            
            private kindPriority(kind: DefinitionKind): number {
    return kind === 'struct' ? 0 : 1;
  }

  private removeFile(uri: vscode.Uri): void {
    for (const [sid, entries] of this.definitions) {
      const filtered = entries.filter((entry) => entry.uri.toString() !== uri.toString());
      if (filtered.length === 0) this.definitions.delete(sid);
      else if (filtered.length !== entries.length) this.definitions.set(sid, filtered);
    }
  }
}
