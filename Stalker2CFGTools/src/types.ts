import * as vscode from 'vscode';

export type DefinitionKind = 'struct' | 'sid';

export interface SidDefinition {
  sid: string;
  uri: vscode.Uri;
  range: vscode.Range;
  kind: DefinitionKind;
  isReference: boolean;
}
