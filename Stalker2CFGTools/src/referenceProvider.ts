import * as vscode from 'vscode';
import { SymbolIndex } from './symbolIndex';

const SID_WORD = /[A-Za-z_][A-Za-z0-9_]*/;

export class StalkerReferenceProvider implements vscode.ReferenceProvider {
  constructor(private readonly index: SymbolIndex) {}

  provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.ReferenceContext
  ): vscode.Location[] | undefined {
    const range = document.getWordRangeAtPosition(position, SID_WORD);
    if (!range) return undefined;

    const sid = document.getText(range);
    const locations = this.index.findReferences(sid).map(
      (reference) => new vscode.Location(reference.uri, reference.range)
    );

    if (context.includeDeclaration) {
      for (const definition of this.index.find(sid, document.uri)) {
        locations.push(new vscode.Location(definition.uri, definition.range));
      }
    }

    return locations.length > 0 ? locations : undefined;
  }
}
