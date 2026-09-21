import * as vscode from 'vscode';
import { SymbolIndex } from './symbolIndex';

const SID_WORD = /[A-Za-z_][A-Za-z0-9_]*/;
const STRUCT_HEADER = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*struct\.begin\b/;

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

    // When the cursor is on the name of a struct definition, that exact local
    // definition wins. Nested struct names are not globally unique.
    const line = document.lineAt(position.line).text;
    const structMatch = line.match(STRUCT_HEADER);
    if (structMatch?.[1] === sid) {
      const start = line.indexOf(sid);
      const localRange = new vscode.Range(position.line, start, position.line, start + sid.length);
      if (localRange.intersection(range)) {
        return new vscode.Location(document.uri, localRange);
      }
    }

    const definitions = this.index.find(sid, document.uri);

    if (definitions.length === 0) {
      return undefined;
    }

    return definitions.map(
      (definition) => new vscode.Location(definition.uri, definition.range)
    );
  }
}
