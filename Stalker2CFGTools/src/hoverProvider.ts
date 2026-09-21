import * as vscode from 'vscode';
import { SymbolIndex } from './symbolIndex';

const SID_WORD = /[A-Za-z_][A-Za-z0-9_]*/;

export class StalkerHoverProvider implements vscode.HoverProvider {
  constructor(private readonly index: SymbolIndex) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Hover | undefined {
    const range = document.getWordRangeAtPosition(position, SID_WORD);
    if (!range) {
      return undefined;
    }

    const sid = document.getText(range);
    const definitions = this.index.find(sid, document.uri);
    if (definitions.length === 0) {
      return undefined;
    }

    // Struct headers are much more useful than the duplicate SID assignment
    // usually contained inside the same prototype.
    const primary = definitions.find((definition) => definition.kind === 'struct') ?? definitions[0];
    const uniqueFiles = new Map<string, typeof primary>();
    for (const definition of definitions) {
      if (!uniqueFiles.has(definition.uri.toString())) {
        uniqueFiles.set(definition.uri.toString(), definition);
      }
    }

    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown(`**${sid}**\n\n`);
    markdown.appendMarkdown(`**Definition:** \`${primary.kind === 'struct' ? 'struct' : 'SID'}\`  \n`);
    markdown.appendMarkdown(`**Source:** \`${vscode.workspace.asRelativePath(primary.uri, false)}`  \n`);
    markdown.appendMarkdown(`**Line:** ${primary.range.start.line + 1}  \n`);
    markdown.appendMarkdown(`**Reference:** ${primary.isReference ? 'yes' : 'no'}`);

    if (uniqueFiles.size > 1) {
      markdown.appendMarkdown(`\n\n---\n\n**Also defined in:**\n`);
      for (const definition of uniqueFiles.values()) {
        if (definition.uri.toString() === primary.uri.toString()) {
          continue;
        }
        markdown.appendMarkdown(
          `- \`${vscode.workspace.asRelativePath(definition.uri, false)}:${definition.range.start.line + 1}\`\n`
        );
      }
    }

    markdown.appendMarkdown('\n\n*F12 / Ctrl+Click to open definition*');
    return new vscode.Hover(markdown, range);
  }
}
