import * as vscode from 'vscode';
import { SymbolIndex } from './symbolIndex';

const SID_WORD = /[A-Za-z_][A-Za-z0-9_]*/;
const STRUCT_HEADER = /^\s*[A-Za-z_][A-Za-z0-9_]*\s*:\s*struct\.begin(?:\s*\{([^}]*)\})?/;
const PROPERTY = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/;
const MAX_PROPERTIES = 10;
const decoder = new TextDecoder('utf-8');

interface StructReference {
  refurl?: string;
  refkey?: string;
  bpatch: boolean;
}

interface StructPreview {
  reference?: StructReference;
  properties: Array<{ key: string; value: string }>;
  truncated: boolean;
}

export class StalkerHoverProvider implements vscode.HoverProvider {
  constructor(private readonly index: SymbolIndex) {}

  async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    const range = document.getWordRangeAtPosition(position, SID_WORD);
    if (!range) return undefined;

    const sid = document.getText(range);

    const enumHover = this.buildEnumHover(document, position, range, sid);
    if (enumHover) return enumHover;

    // A struct header under the cursor is a local definition. Nested names such
    // as "PostShooting" are intentionally reused all over the CFG data and must
    // not be resolved through the global SID index.
    const localStruct = this.localStructAtPosition(document, position, range, sid);
    if (localStruct) {
      const preview = await this.readStructPreview(document.uri, localStruct.line);
      return this.buildLocalStructHover(document, range, sid, localStruct.line, preview);
    }

    const definitions = this.index.find(sid, document.uri);
    if (definitions.length === 0) return undefined;

    const primary = definitions.find((definition) => definition.kind === 'struct') ?? definitions[0];
    const uniqueFiles = new Map<string, (typeof definitions)[number]>();
    for (const definition of definitions) {
      if (!uniqueFiles.has(definition.uri.toString())) uniqueFiles.set(definition.uri.toString(), definition);
    }

    const preview = primary.kind === 'struct' ? await this.readStructPreview(primary.uri, primary.range.start.line) : undefined;
    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown('## ' + this.escape(sid) + '\n');

    this.appendReference(markdown, preview?.reference, primary.uri);
    this.appendInheritance(markdown, sid, primary.uri);
    this.appendPatches(markdown, sid);

    this.appendUsages(markdown, sid);

    this.heading(markdown, 'Definition', '📍');
    markdown.appendMarkdown('**Kind:** ' + (primary.kind === 'struct' ? 'struct' : 'SID') + '  \n');
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

  private buildEnumHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    range: vscode.Range,
    word: string
  ): vscode.Hover | undefined {
    const line = document.lineAt(position.line).text;
    const enumMatch = line.match(/\b(E[A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)\b/);
    if (!enumMatch) return undefined;

    const type = enumMatch[1];
    const value = enumMatch[2];
    if (word !== type && word !== value) return undefined;

    const values = this.index.findEnumValues(type);
    if (values.length === 0) return undefined;

    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown('## ' + this.escape(type) + '\n\n');
    markdown.appendMarkdown('**Observed values in indexed CFG files**\n\n');

    for (const entry of values) {
      const current = entry.value === value ? '  ← **current**' : '';
      markdown.appendMarkdown('- ' + this.badge(entry.value) + ' · **' + entry.count + '** usage' + (entry.count === 1 ? '' : 's') + current + '\n');
    }

    const total = values.reduce((sum, entry) => sum + entry.count, 0);
    markdown.appendMarkdown(
      '\n**' + values.length + ' observed value' + (values.length === 1 ? '' : 's') +
      ' · ' + total + ' usages**'
    );
    markdown.appendMarkdown('\n\n*Observed from CFG data; this may not be the complete engine enum.*');

    return new vscode.Hover(markdown, range);
  }

  private localStructAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position,
    wordRange: vscode.Range,
    sid: string
  ): { line: number } | undefined {
    const line = document.lineAt(position.line).text;
    const match = line.match(STRUCT_HEADER);
    if (!match) return undefined;

    const nameMatch = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/);
    if (!nameMatch || nameMatch[1] !== sid) return undefined;

    const start = line.indexOf(nameMatch[1]);
    const nameRange = new vscode.Range(position.line, start, position.line, start + nameMatch[1].length);
    return nameRange.intersection(wordRange) ? { line: position.line } : undefined;
  }

  private buildLocalStructHover(
    document: vscode.TextDocument,
    range: vscode.Range,
    sid: string,
    line: number,
    preview?: StructPreview
  ): vscode.Hover {
    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown('## ' + this.escape(sid) + '\n');
    this.appendReference(markdown, preview?.reference, document.uri);
    this.appendInheritance(markdown, sid, document.uri);
    this.appendPatches(markdown, sid);
    this.appendUsages(markdown, sid);
    this.heading(markdown, 'Definition', '📍');
    markdown.appendMarkdown('**Kind:** local struct  \n');
    markdown.appendMarkdown('**Source:** `' + this.escapeCode(vscode.workspace.asRelativePath(document.uri, false)) + '`  \n');
    markdown.appendMarkdown('**Line:** ' + (line + 1));
    return new vscode.Hover(markdown, range);
  }

  private appendInheritance(markdown: vscode.MarkdownString, sid: string, sourceUri: vscode.Uri): void {
    const chain = this.index.getInheritanceChain(sid, sourceUri);
    if (chain.length <= 1) return;

    this.heading(markdown, 'Inheritance', '🧬');
    for (let i = 0; i < chain.length; i++) {
      const step = chain[i];
      const prefix = i === 0 ? '' : '→ ';
      let suffix = '';
      if (step.cycle) suffix = '  **cycle**';
      else if (step.unresolved) suffix = '  **unresolved**';
      else if (step.isReference) suffix = '  *Base/Reference*';
      markdown.appendMarkdown(prefix + '`' + this.escapeCode(step.sid) + '`' + suffix + '  \n');
    }
  }

  private appendPatches(markdown: vscode.MarkdownString, sid: string): void {
    const patches = this.index.findPatches(sid);
    if (patches.length === 0) return;

    this.heading(markdown, 'Patches', '🩹');
    for (const patch of patches.slice(0, 5)) {
      markdown.appendMarkdown(
        '- `' + this.escapeCode(vscode.workspace.asRelativePath(patch.uri, false)) +
        ':' + (patch.range.start.line + 1) + '`  \n'
      );
    }
    if (patches.length > 5) {
      markdown.appendMarkdown('- *…' + (patches.length - 5) + ' more patches*  \n');
    }
  }

  private appendUsages(markdown: vscode.MarkdownString, sid: string): void {
    const references = this.index.findReferences(sid);
    if (references.length === 0) return;

    this.heading(markdown, 'Used by', '🔎');
    const shown = references.slice(0, 5);
    for (const reference of shown) {
      const owner = reference.owner && reference.owner !== sid ? reference.owner + ' — ' : '';
      const source = vscode.workspace.asRelativePath(reference.uri, false);
      markdown.appendMarkdown(
        '- ' + this.escape(owner) + '`' + this.escapeCode(source) + ':' + (reference.range.start.line + 1) + '`  \n'
      );
    }
    if (references.length > shown.length) {
      markdown.appendMarkdown('- *…' + (references.length - shown.length) + ' more references*  \n');
    }
    markdown.appendMarkdown('**References:** ' + references.length + '  \n');
  }

  private async readStructPreview(uri: vscode.Uri, startLine: number): Promise<StructPreview | undefined> {
    try {
      const text = decoder.decode(await vscode.workspace.fs.readFile(uri));
      const lines = text.split(/\r?\n/);
      const header = lines[startLine];
      if (header === undefined) return undefined;

      const headerMatch = header.match(STRUCT_HEADER);
      const reference = this.extractReference(headerMatch?.[1]);
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

      return { reference, properties, truncated };
    } catch {
      return undefined;
    }
  }

  private extractReference(attributes?: string): StructReference | undefined {
    if (!attributes) return undefined;
    const refurl = attributes.match(/(?:^|;)\s*refurl\s*=\s*([^;}]+)/)?.[1]?.trim();
    const refkey = attributes.match(/(?:^|;)\s*refkey\s*=\s*([^;}]+)/)?.[1]?.trim();
    const bpatch = /(?:^|;)\s*bpatch(?:\s*(?:=\s*true)?)?(?=;|$)/i.test(attributes.trim());
    if (!refurl && !refkey && !bpatch) return undefined;
    return { refurl, refkey, bpatch };
  }

  private appendReference(markdown: vscode.MarkdownString, reference: StructReference | undefined, uri: vscode.Uri): void {
    if (!reference) return;

    const isBaseReference = this.index.isReferenceUri(uri);

    if (reference.bpatch) {
      markdown.appendMarkdown('\n**Patch:** modifies existing node  \n');
      return;
    }

    if (reference.refurl && reference.refkey) {
      const rootLabel = /^\[\d+\]$/.test(reference.refkey)
        ? 'root prototype'
        : '`' + this.escapeCode(reference.refkey) + '`';

      markdown.appendMarkdown(
        '**Base:** `' + this.escapeCode(reference.refurl) + '`  \n' +
        '**Parent:** ' + rootLabel + '  \n'
      );
      return;
    }

    if (reference.refkey) {
      // [0] is the root/base node of the current prototype context. In a
      // VanillaReference file it adds no useful inheritance information.
      if (/^\[\d+\]$/.test(reference.refkey)) {
        if (!isBaseReference) {
          markdown.appendMarkdown('**Base:** current prototype root `' + this.escapeCode(reference.refkey) + '`  \n');
        }
      } else {
        markdown.appendMarkdown('**Parent:** `' + this.escapeCode(reference.refkey) + '`  \n');
      }
      return;
    }

    markdown.appendMarkdown('**Base:** `' + this.escapeCode(reference.refurl!) + '`  \n');
  }


  private heading(markdown: vscode.MarkdownString, title: string): void {
    markdown.appendMarkdown('\n---\n\n### ' + this.escape(title) + '\n\n');
  }

  private badge(value: string): string {
    return '`' + this.escapeCode(value) + '`';
  }

  private escape(value: string): string {
    return value.replace(/([\\`*_{}\[\]()#+\-.!])/g, '\\$1');
  }

  private escapeCode(value: string): string {
    return value.replace(/`/g, '\\`');
  }
}
