import * as vscode from 'vscode';
import { SymbolIndex } from './symbolIndex';

const SID_WORD = /[A-Za-z_][A-Za-z0-9_]*/;

export class StalkerDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly index: SymbolIndex) {}

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Definition | undefined {
    const range = document.getWordRangeAtPosition(position, SID_WORD);
    if (!range) {
      return undefined;
    }

    const sid = document.getText(range);
    const definitions = this.index.find(sid);

    if (definitions.length === 0) {
      return undefined;
    }

    return definitions.map(
      (definition) => new vscode.Location(definition.uri, definition.range)
    );
  }
}
