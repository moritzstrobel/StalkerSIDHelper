import * as vscode from 'vscode';

export interface SidDefinition {
  sid: string;
  uri: vscode.Uri;
  range: vscode.Range;
}
