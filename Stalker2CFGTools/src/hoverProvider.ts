import * as vscode from 'vscode';
import { SymbolIndex } from './symbolIndex';

const SID_WORD = /[A-Za-z_][A-Za-z0-9_]*/;
const STRUCT_HEADER = /^\s*[A-Za-z_][A-Za-z0-9_]*\s*:\s*struct\.begin(?:\s*\{([^}]*)\})?/;
const PROPERTY = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/;
const MAX_PROPERTIES = 10;
const decoder = new TextDecoder('utf-8');

interface StructPreview {
  parent?: string;
  properties: Array<{ key: string; value: string }>;
  truncated: boolean;
}

export class StalkerHoverProvider implements vscode.HoverProvider {
  constructor(private readonly index: SymbolIndex) {}

  async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    const range = document.getWordRangeAtPosition(position, SID_WORD);
    if (!range) return undefined;

    const sid = document.getText(range);
    const definitions = this.index.find(sid, document.uri);
    if (definitions.length === 0) return undefined;

    const primary = definitions.find((definition) => definition.kind === 'struct') ?? definitions[0];
    const uniqueFiles = new Map<string, (typeof definitions)[number]>();
    for (const definition of definitions) {
      if (!uniqueFiles.has(definition.uri.toString())) uniqueFiles.set(definition.uri.toString(), definition);
    }

    const preview = primary.kind === 'struct' ? await this.readStructPreview(primary.uri, primary.range.start.line) : undefined;
    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown('**' + this.escape(sid) + '**\n\n');

    if (preview?.parent) markdown.appendMarkdown('**Parent:** `' + this.escapeCode(preview.parent) + '`  \n');

    if (preview && preview.properties.length > 0) {
      markdown.appendMarkdown('\n');
      for (const property of preview.properties) {
        markdown.appendMarkdown('**' + this.escape(property.key) + ':** `' + this.escapeCode(property.value) + '`  \n');
      }
      if (preview.truncated) markdown.appendMarkdown('*…more properties in definition*  \n');
      markdown.appendMarkdown('\n---\n\n');
    }

    markdown.appendMarkdown('**Definition:** ' + (primary.kind === 'struct' ? 'struct' : 'SID') + '  \n');
    markdown.appendMarkdown('**Source:** `' + this.escapeCode(vscode.workspace.asRelativePath(primary.uri, false)) + '`  \n');
    markdown.appendMarkdown('**Line:** ' + (primary.range.start.line + 1) + '  \n');
    markdown.appendMarkdown('**Reference:** ' + (primary.isReference ? 'yes' : 'no'));

    if (uniqueFiles.size > 1) {
      markdown.appendMarkdown('\n\n**Also defined in:**\n');
      for (const definition of uniqueFiles.values()) {
        if (definition.uri.toString() === primary.uri.toString()) continue;
        markdown.appendMarkdown('- `' + this.escapeCode(vscode.workspace.asRelativePath(definition.uri, false)) + ':' + (definition.range.start.line + 1) + '`\n');
      }
    }

    markdown.appendMarkdown('\n\n*F12 / Ctrl+Click to open definition*');
    return new vscode.Hover(markdown, range);
  }

  private async readStructPreview(uri: vscode.Uri, startLine: number): Promise<StructPreview | undefined> {
    try {
      const text = decoder.decode(await vscode.workspace.fs.readFile(uri));
      const lines = text.split(/\r?\n/);
      const header = lines[startLine];
      if (header === undefined) return undefined;

      const headerMatch = header.match(STRUCT_HEADER);
      const parent = this.extractParent(headerMatch?.[1]);
      const properties: Array<{ key: string; value: string }> = [];
      let depth = 1;
      let truncated = false;

      for (let i = startLine + 1; i < lines.length && depth > 0; i++) {
        const line = lines[i];
        const begins = (line.match(/struct\.begin\b/g) ?? []).length;
        const ends = (line.match(/struct\.end\b/g) ?? []).length;

        if (depth === 1 && begins === 0 && ends === 0) {
          const match = line.match(PROPERTY);
          if (match && match[1] !== 'SID') {
            if (properties.length < MAX_PROPERTIES) properties.push({ key: match[1], value: match[2] });
            else truncated = true;
          } else if (match && match[1] === 'SID' && properties.length < MAX_PROPERTIES) {
            properties.push({ key: match[1], value: match[2] });
          }
        }

        depth += begins;
        depth -= ends;
      }

      return { parent, properties, truncated };
    } catch {
      return undefined;
    }
  }

  private extractParent(attributes?: string): string | undefined {
    if (!attributes) return undefined;
    const match = attributes.match(/(?:refkey|refurl)\s*=\s*([^,}]+)/);
    return match?.[1]?.trim();
  }

  private escape(value: string): string {
    return value.replace(/([\\`*_{}\[\]()#+\-.!])/g, '\\$1');
  }

  private escapeCode(value: string): string {
    return value.replace(/`/g, '\\`');
  }
}
