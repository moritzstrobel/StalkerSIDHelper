import * as vscode from 'vscode';
import { SymbolIndex } from './symbolIndex';

const SID_WORD = /[A-Za-z_][A-Za-z0-9_]*/;
const STRUCT_HEADER = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*struct\.begin\b/;
const BASEGAME_REFURL = /refurl\s*=\s*(@BaseGame\/[^;}\s]+)/i;

export class StalkerDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly index: SymbolIndex) {}

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Definition | undefined {
    const line = document.lineAt(position.line).text;

    // @BaseGame/... is a file reference rather than a SID. Resolve it through
    // the configured referencePaths so Ctrl+Click/F12 works with different
    // mod workspace layouts.
    const baseGameLocation = this.baseGameReferenceAtPosition(document, position, line);
    if (baseGameLocation) {
      return baseGameLocation;
    }

    const range = document.getWordRangeAtPosition(position, SID_WORD);
    if (!range) {
      return undefined;
    }

    const sid = document.getText(range);

    // When the cursor is on the name of a struct definition, that exact local
    // definition wins. Nested struct names are not globally unique.
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

  private baseGameReferenceAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position,
    line: string
  ): vscode.Location | undefined {
    const match = line.match(BASEGAME_REFURL);
    if (!match || match.index === undefined) return undefined;

    const value = match[1];
    const valueStart = line.indexOf(value, match.index);
    const valueRange = new vscode.Range(position.line, valueStart, position.line, valueStart + value.length);
    if (!valueRange.contains(position)) return undefined;

    const target = this.index.resolveBaseGameRef(value);
    return target ? new vscode.Location(target, new vscode.Position(0, 0)) : undefined;
  }
}
