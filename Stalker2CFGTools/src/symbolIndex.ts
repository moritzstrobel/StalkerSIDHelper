import * as vscode from 'vscode';
import { DefinitionKind, SidDefinition } from './types';

const STRUCT_DEFINITION = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*struct\.begin\b/;
const SID_ASSIGNMENT = /^\s*SID\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\b/;
const decoder = new TextDecoder('utf-8');
const IDENTIFIER = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
const ENUM_VALUE = /\b(E[A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)\b/g;

export interface SidReference {
  sid: string;
  uri: vscode.Uri;
  range: vscode.Range;
  owner?: string;
}

export interface EnumUsage {
  type: string;
  value: string;
  uri: vscode.Uri;
  range: vscode.Range;
  owner?: string;
}

export interface EnumValueSummary {
  value: string;
  count: number;
}

export interface IndexStats {
  files: number;
  symbols: number;
  definitions: number;
  durationMs: number;
}

export class SymbolIndex {
  private readonly definitions = new Map<string, SidDefinition[]>();
  private readonly references = new Map<string, SidReference[]>();
  private readonly enumUsages = new Map<string, Map<string, EnumUsage[]>>();
  private readonly fileTexts = new Map<string, { uri: vscode.Uri; lines: string[] }>();
  private output?: vscode.OutputChannel;

  constructor(output?: vscode.OutputChannel) {
    this.output = output;
  }

  clear(): void {
    this.definitions.clear();
    this.references.clear();
    this.enumUsages.clear();
    this.fileTexts.clear();
  }

  async rebuild(): Promise<IndexStats> {
    const started = Date.now();
    this.clear();
    const files = await vscode.workspace.findFiles('**/*.cfg', '**/{node_modules,.git,out,dist}/**');
    const batchSize = 25;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      await Promise.all(batch.map((uri) => this.indexFile(uri)));
    }

    this.buildReferences();
    this.buildEnums();
    const definitions = Array.from(this.definitions.values()).reduce((sum, entries) => sum + entries.length, 0);
    const stats = {
      files: files.length,
      symbols: this.definitions.size,
      definitions,
      durationMs: Date.now() - started
    };

    this.output?.appendLine('Index ready: ' + stats.files + ' files, ' + stats.symbols + ' symbols, ' + stats.definitions + ' definitions in ' + stats.durationMs + ' ms.');
    return stats;
  }

  async indexFile(uri: vscode.Uri): Promise<void> {
    this.removeFile(uri);

    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch (error) {
      this.output?.appendLine('ERROR reading ' + uri.fsPath + ': ' + String(error));
      console.warn('STALKER 2 CFG Tools: failed to read ' + uri.fsPath, error);
      return;
    }

    const text = decoder.decode(bytes);
    const lines = text.split(/\r?\n/);
    this.fileTexts.set(uri.toString(), { uri, lines });

    for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
      const line = lines[lineNumber];
      const structMatch = line.match(STRUCT_DEFINITION);
      if (structMatch) this.add(structMatch[1], uri, lineNumber, line.indexOf(structMatch[1]), 'struct');

      const sidMatch = line.match(SID_ASSIGNMENT);
      if (sidMatch) this.add(sidMatch[1], uri, lineNumber, line.indexOf(sidMatch[1]), 'sid');
    }
  }

  findEnumValues(type: string): EnumValueSummary[] {
    const values = this.enumUsages.get(type);
    if (!values) return [];
    return [...values.entries()]
      .map(([value, usages]) => ({ value, count: usages.length }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }

  findEnumUsages(type: string, value?: string): EnumUsage[] {
    const values = this.enumUsages.get(type);
    if (!values) return [];
    const usages = value
      ? [...(values.get(value) ?? [])]
      : [...values.values()].flat();
    return usages.sort(
      (a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath) || a.range.start.line - b.range.start.line
    );
  }

  private buildEnums(): void {
    this.enumUsages.clear();

    for (const { uri, lines } of this.fileTexts.values()) {
      let owner: string | undefined;
      let depth = 0;

      for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
        const line = lines[lineNumber];
        const topStruct = line.match(STRUCT_DEFINITION);
        if (topStruct && depth === 0) owner = topStruct[1];

        ENUM_VALUE.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = ENUM_VALUE.exec(line)) !== null) {
          const type = match[1];
          const value = match[2];
          const valueOffset = match.index + type.length + 2;
          const range = new vscode.Range(
            new vscode.Position(lineNumber, valueOffset),
            new vscode.Position(lineNumber, valueOffset + value.length)
          );
          const values = this.enumUsages.get(type) ?? new Map<string, EnumUsage[]>();
          const usages = values.get(value) ?? [];
          usages.push({ type, value, uri, range, owner });
          values.set(value, usages);
          this.enumUsages.set(type, values);
        }

        depth += (line.match(/struct\.begin\b/g) ?? []).length;
        depth -= (line.match(/struct\.end\b/g) ?? []).length;
        if (depth <= 0) {
          depth = 0;
          owner = undefined;
        }
      }
    }
  }

  findReferences(sid: string): SidReference[] {
    return [...(this.references.get(sid) ?? [])].sort(
      (a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath) || a.range.start.line - b.range.start.line
    );
  }

  private buildReferences(): void {
    this.references.clear();
    const known = new Set(this.definitions.keys());

    for (const { uri, lines } of this.fileTexts.values()) {
      let owner: string | undefined;
      let depth = 0;

      for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
        const line = lines[lineNumber];
        const topStruct = line.match(STRUCT_DEFINITION);
        if (topStruct && depth === 0) owner = topStruct[1];

        IDENTIFIER.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = IDENTIFIER.exec(line)) !== null) {
          const sid = match[0];
          if (!known.has(sid)) continue;

          const definitionsHere = this.definitions.get(sid) ?? [];
          const isDefinition = definitionsHere.some(
            (d) => d.uri.toString() === uri.toString() &&
              d.range.start.line === lineNumber &&
              d.range.start.character === match!.index
          );
          if (isDefinition) continue;

          const range = new vscode.Range(
            new vscode.Position(lineNumber, match.index),
            new vscode.Position(lineNumber, match.index + sid.length)
          );
          const entries = this.references.get(sid) ?? [];
          entries.push({ sid, uri, range, owner });
          this.references.set(sid, entries);
        }

        depth += (line.match(/struct\.begin\b/g) ?? []).length;
        depth -= (line.match(/struct\.end\b/g) ?? []).length;
        if (depth <= 0) {
          depth = 0;
          owner = undefined;
        }
      }
    }
  }

  find(sid: string, sourceUri?: vscode.Uri): SidDefinition[] {
    const definitions = [...(this.definitions.get(sid) ?? [])];
    return definitions.sort((a, b) => {
      const referenceDifference = Number(b.isReference) - Number(a.isReference);
      if (referenceDifference !== 0) return referenceDifference;

      if (sourceUri) {
        const source = sourceUri.toString();
        const aLocal = a.uri.toString() === source ? 1 : 0;
        const bLocal = b.uri.toString() === source ? 1 : 0;
        if (aLocal !== bLocal) return bLocal - aLocal;
      }

      const kindDifference = this.kindPriority(a.kind) - this.kindPriority(b.kind);
      if (kindDifference !== 0) return kindDifference;

      return a.uri.fsPath.localeCompare(b.uri.fsPath) || a.range.start.line - b.range.start.line;
    });
  }

  private add(sid: string, uri: vscode.Uri, line: number, character: number, kind: DefinitionKind): void {
    const range = new vscode.Range(new vscode.Position(line, character), new vscode.Position(line, character + sid.length));
    const entries = this.definitions.get(sid) ?? [];
    entries.push({ sid, uri, range, kind, isReference: this.isReferencePath(uri) });
    this.definitions.set(sid, entries);
  }

  private isReferencePath(uri: vscode.Uri): boolean {
    const configuredPaths = vscode.workspace.getConfiguration('stalker2Cfg').get<string[]>('referencePaths', []);
    if (!vscode.workspace.getWorkspaceFolder(uri)) return false;

    const relativePath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/').toLowerCase();
    return configuredPaths.some((configuredPath) => {
      const normalized = configuredPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '').toLowerCase();
      return relativePath === normalized || relativePath.startsWith(normalized + '/');
    });
  }

  private kindPriority(kind: DefinitionKind): number {
    return kind === 'struct' ? 0 : 1;
  }

  private removeFile(uri: vscode.Uri): void {
    this.fileTexts.delete(uri.toString());
    // References depend on the complete set of known definitions. A full
    // rebuild recreates them; live file updates refresh them below.
    for (const [sid, entries] of this.definitions) {
      const filtered = entries.filter((entry) => entry.uri.toString() !== uri.toString());
      if (filtered.length === 0) this.definitions.delete(sid);
      else if (filtered.length !== entries.length) this.definitions.set(sid, filtered);
    }
  }
}
