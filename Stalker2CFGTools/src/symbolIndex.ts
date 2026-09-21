import * as vscode from 'vscode';
import { DefinitionKind, SidDefinition } from './types';

const STRUCT_DEFINITION = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*struct\.begin\b/;
const SID_ASSIGNMENT = /^\s*SID\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\b/;

export class SymbolIndex {
  private readonly definitions = new Map<string, SidDefinition[]>();

  clear(): void {
    this.definitions.clear();
  }

  async rebuild(): Promise<void> {
    this.clear();

    const files = await vscode.workspace.findFiles(
      '**/*.cfg',
      '**/{node_modules,.git,out,dist}/**'
    );

    await Promise.all(files.map((uri) => this.indexFile(uri)));
  }

  async indexFile(uri: vscode.Uri): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    this.removeFile(uri);

    for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
      const text = document.lineAt(lineNumber).text;

      const structMatch = text.match(STRUCT_DEFINITION);
      if (structMatch) {
        this.add(structMatch[1], uri, lineNumber, text.indexOf(structMatch[1]), 'struct');
      }

      const sidMatch = text.match(SID_ASSIGNMENT);
      if (sidMatch) {
        this.add(sidMatch[1], uri, lineNumber, text.indexOf(sidMatch[1]), 'sid');
      }
    }
  }

  find(sid: string, sourceUri?: vscode.Uri): SidDefinition[] {
    const definitions = [...(this.definitions.get(sid) ?? [])];

    return definitions.sort((a, b) => {
      const referenceDifference = Number(b.isReference) - Number(a.isReference);
      if (referenceDifference !== 0) {
        return referenceDifference;
      }

      // When navigating inside the actual definition file, keep the local
      // definition convenient instead of always bouncing into VanillaReference.
      if (sourceUri) {
        const source = sourceUri.toString();
        const aLocal = a.uri.toString() === source ? 1 : 0;
        const bLocal = b.uri.toString() === source ? 1 : 0;
        if (aLocal !== bLocal) {
          return bLocal - aLocal;
        }
      }

      // A struct header is generally the useful target. "SID = Foo" usually
      // lives inside that same struct and would otherwise create duplicates.
      const kindDifference = this.kindPriority(a.kind) - this.kindPriority(b.kind);
      if (kindDifference !== 0) {
        return kindDifference;
      }

      return a.uri.fsPath.localeCompare(b.uri.fsPath) || a.range.start.line - b.range.start.line;
    });
  }

  private add(
    sid: string,
    uri: vscode.Uri,
    line: number,
    character: number,
    kind: DefinitionKind
  ): void {
    const range = new vscode.Range(
      new vscode.Position(line, character),
      new vscode.Position(line, character + sid.length)
    );

    const entries = this.definitions.get(sid) ?? [];
    entries.push({
      sid,
      uri,
      range,
      kind,
      isReference: this.isReferencePath(uri)
    });
    this.definitions.set(sid, entries);
  }

  private isReferencePath(uri: vscode.Uri): boolean {
    const configuration = vscode.workspace.getConfiguration('stalker2Cfg');
    const configuredPaths = configuration.get<string[]>('referencePaths', []);

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) {
      return false;
    }

    const relativePath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/').toLowerCase();

    return configuredPaths.some((configuredPath) => {
      const normalized = configuredPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '').toLowerCase();
      return relativePath === normalized || relativePath.startsWith(normalized + '/');
    });
  }

  private kindPriority(kind: DefinitionKind): number {
    return kind === 'struct' ? 0 : 1;
  }

  private removeFile(uri: vscode.Uri): void {
    for (const [sid, entries] of this.definitions) {
      const filtered = entries.filter((entry) => entry.uri.toString() !== uri.toString());
      if (filtered.length === 0) {
        this.definitions.delete(sid);
      } else if (filtered.length !== entries.length) {
        this.definitions.set(sid, filtered);
      }
    }
  }
}
