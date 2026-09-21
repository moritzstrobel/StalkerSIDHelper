import * as vscode from 'vscode';
import { SidDefinition } from './types';

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
      const line = document.lineAt(lineNumber);
      const text = line.text;

      const structMatch = text.match(STRUCT_DEFINITION);
      if (structMatch) {
        this.add(structMatch[1], uri, lineNumber, text.indexOf(structMatch[1]));
      }

      const sidMatch = text.match(SID_ASSIGNMENT);
      if (sidMatch) {
        this.add(sidMatch[1], uri, lineNumber, text.indexOf(sidMatch[1]));
      }
    }
  }

  find(sid: string): SidDefinition[] {
    return this.definitions.get(sid) ?? [];
  }

  private add(sid: string, uri: vscode.Uri, line: number, character: number): void {
    const range = new vscode.Range(
      new vscode.Position(line, character),
      new vscode.Position(line, character + sid.length)
    );

    const entries = this.definitions.get(sid) ?? [];
    entries.push({ sid, uri, range });
    this.definitions.set(sid, entries);
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
