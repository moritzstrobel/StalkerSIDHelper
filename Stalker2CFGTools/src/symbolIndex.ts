import * as vscode from 'vscode';
import { DefinitionKind, SidDefinition } from './types';

const STRUCT_DEFINITION = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*struct\.begin\b(?:\s*\{([^}]*)\})?/;
const SID_ASSIGNMENT = /^\s*SID\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\b/;
const decoder = new TextDecoder('utf-8');
const IDENTIFIER = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
const ENUM_VALUE = /\b(E[A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)\b/g;

export interface PrototypeNode {
  sid: string;
  uri: vscode.Uri;
  range: vscode.Range;
  isReference: boolean;
  kind: 'definition' | 'patch';
  parent?: string;
  refurl?: string;
}

export interface StructPathInfo {
  names: string[];
  path: string;
  depth: number;
}

export interface PatchTarget {
  uri: vscode.Uri;
  range: vscode.Range;
  path: string;
}

export interface PropertyInfo {
  key: string;
  value: string;
  uri: vscode.Uri;
  range: vscode.Range;
  structPath: string;
  propertyPath: string;
}

export interface PropertyComparison {
  local: PropertyInfo;
  target?: PropertyInfo;
  targetStruct?: PatchTarget;
  mode?: 'patch' | 'inheritance';
  inheritedFrom?: string;
}

export interface InheritanceStep {
  sid: string;
  uri?: vscode.Uri;
  isReference?: boolean;
  unresolved?: boolean;
  cycle?: boolean;
}

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
  private readonly prototypes = new Map<string, PrototypeNode[]>();
  private readonly references = new Map<string, SidReference[]>();
  private readonly enumUsages = new Map<string, Map<string, EnumUsage[]>>();
  private readonly fileTexts = new Map<string, { uri: vscode.Uri; lines: string[] }>();
  private output?: vscode.OutputChannel;

  constructor(output?: vscode.OutputChannel) {
    this.output = output;
  }

  clear(): void {
    this.definitions.clear();
    this.prototypes.clear();
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

    let depth = 0;
    for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
      const line = lines[lineNumber];
      const structMatch = line.match(STRUCT_DEFINITION);
      if (structMatch) {
        const sid = structMatch[1];
        const character = line.indexOf(sid);
        this.add(sid, uri, lineNumber, character, 'struct');
        if (depth === 0) this.addPrototype(sid, uri, lineNumber, character, structMatch[2]);
      }

      const sidMatch = line.match(SID_ASSIGNMENT);
      if (sidMatch) this.add(sidMatch[1], uri, lineNumber, line.indexOf(sidMatch[1]), 'sid');

      depth += (line.match(/struct\.begin\b/g) ?? []).length;
      depth -= (line.match(/struct\.end\b/g) ?? []).length;
      if (depth < 0) depth = 0;
    }
  }

  getStructPath(uri: vscode.Uri, lineNumber: number): StructPathInfo | undefined {
    const file = this.fileTexts.get(uri.toString());
    if (!file) return undefined;

    const stack: string[] = [];
    for (let line = 0; line <= lineNumber && line < file.lines.length; line++) {
      const text = file.lines[line];
      const match = text.match(STRUCT_DEFINITION);
      if (match) stack.push(match[1]);

      const ends = (text.match(/struct\.end\b/g) ?? []).length;
      for (let i = 0; i < ends; i++) stack.pop();
    }

    if (stack.length === 0) return undefined;
    return { names: [...stack], path: stack.join('.'), depth: stack.length - 1 };
  }

  getPropertyAt(uri: vscode.Uri, lineNumber: number): PropertyInfo | undefined {
    const file = this.fileTexts.get(uri.toString());
    if (!file || lineNumber < 0 || lineNumber >= file.lines.length) return undefined;

    const line = file.lines[lineNumber];
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (!match) return undefined;

    const struct = this.getStructPath(uri, lineNumber);
    if (!struct) return undefined;

    const key = match[1];
    const character = line.indexOf(key);
    return {
      key,
      value: match[2],
      uri,
      range: new vscode.Range(
        new vscode.Position(lineNumber, character),
        new vscode.Position(lineNumber, character + key.length)
      ),
      structPath: struct.path,
      propertyPath: struct.path + '.' + key
    };
  }

  compareProperty(uri: vscode.Uri, lineNumber: number): PropertyComparison | undefined {
    const local = this.getPropertyAt(uri, lineNumber);
    if (!local) return undefined;

    const struct = this.getStructPath(uri, lineNumber);
    if (!struct) return { local };

    const headerLine = this.findStructHeaderLine(uri, lineNumber, struct.names.length);
    const targetStruct = this.findPatchTargetAt(uri, headerLine);
    if (targetStruct) {
      const target = this.findDirectProperty(targetStruct.uri, targetStruct.range.start.line, local.key);
      return { local, target, targetStruct, mode: 'patch' };
    }

    // For normal mod definitions, resolve the top-level refkey/refurl chain and
    // look for the same nested struct path below each parent prototype.
    const topHeader = this.findStructHeaderLine(uri, lineNumber, 1);
    const file = this.fileTexts.get(uri.toString());
    const topMatch = file?.lines[topHeader]?.match(STRUCT_DEFINITION);
    const topSid = topMatch?.[1];
    if (!topSid) return { local };

    const chain = this.getInheritanceChain(topSid, uri);
    const nestedPath = struct.names.slice(1);
    for (const step of chain.slice(1)) {
      if (!step.uri || step.unresolved || step.cycle) continue;
      const parent = this.findPrototype(step.sid, step.uri);
      if (!parent) continue;

      const nested = this.findNestedStruct(parent.uri, parent.range.start.line, nestedPath);
      if (!nested) continue;
      const target = this.findDirectProperty(nested.uri, nested.range.start.line, local.key);
      if (target) {
        return {
          local,
          target,
          targetStruct: nested,
          mode: 'inheritance',
          inheritedFrom: step.sid
        };
      }
    }

    return { local, mode: chain.length > 1 ? 'inheritance' : undefined };
  }

  // Kept for callers while the property model is being expanded.
  comparePatchedProperty(uri: vscode.Uri, lineNumber: number): PropertyComparison | undefined {
    return this.compareProperty(uri, lineNumber);
  }

  private findStructHeaderLine(uri: vscode.Uri, lineNumber: number, depth: number): number {
    const file = this.fileTexts.get(uri.toString());
    if (!file) return lineNumber;
    const stack: number[] = [];
    for (let line = 0; line <= lineNumber && line < file.lines.length; line++) {
      const text = file.lines[line];
      if (text.match(STRUCT_DEFINITION)) stack.push(line);
      const ends = (text.match(/struct\.end\b/g) ?? []).length;
      for (let i = 0; i < ends; i++) stack.pop();
    }
    return stack[Math.max(0, depth - 1)] ?? lineNumber;
  }

  private findNestedStruct(uri: vscode.Uri, topLine: number, names: string[]): PatchTarget | undefined {
    if (names.length === 0) {
      const top = this.fileTexts.get(uri.toString())?.lines[topLine]?.match(STRUCT_DEFINITION);
      if (!top) return undefined;
      const character = this.fileTexts.get(uri.toString())!.lines[topLine].indexOf(top[1]);
      return {
        uri,
        range: new vscode.Range(
          new vscode.Position(topLine, character),
          new vscode.Position(topLine, character + top[1].length)
        ),
        path: top[1]
      };
    }

    const file = this.fileTexts.get(uri.toString());
    if (!file) return undefined;
    const stack: Array<{ name: string; line: number; character: number }> = [];
    for (let line = topLine; line < file.lines.length; line++) {
      const text = file.lines[line];
      const match = text.match(STRUCT_DEFINITION);
      if (match) {
        const character = text.indexOf(match[1]);
        stack.push({ name: match[1], line, character });
        const relative = stack.slice(1).map((entry) => entry.name);
        if (relative.length === names.length && relative.every((name, i) => name === names[i])) {
          const current = stack[stack.length - 1];
          return {
            uri,
            range: new vscode.Range(
              new vscode.Position(current.line, current.character),
              new vscode.Position(current.line, current.character + current.name.length)
            ),
            path: stack.map((entry) => entry.name).join('.')
          };
        }
      }
      const ends = (text.match(/struct\.end\b/g) ?? []).length;
      for (let i = 0; i < ends; i++) stack.pop();
      if (line > topLine && stack.length === 0) break;
    }
    return undefined;
  }

  private findDirectProperty(uri: vscode.Uri, structLine: number, key: string): PropertyInfo | undefined {
    const file = this.fileTexts.get(uri.toString());
    if (!file) return undefined;

    let depth = 1;
    for (let line = structLine + 1; line < file.lines.length && depth > 0; line++) {
      const text = file.lines[line];
      const begins = (text.match(/struct\.begin\b/g) ?? []).length;
      const ends = (text.match(/struct\.end\b/g) ?? []).length;

      if (depth === 1 && begins === 0 && ends === 0) {
        const match = text.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/);
        if (match?.[1] === key) return this.getPropertyAt(uri, line);
      }

      depth += begins;
      depth -= ends;
    }
    return undefined;
  }

  findPatchTargetAt(patchUri: vscode.Uri, lineNumber: number): PatchTarget | undefined {
    const path = this.getStructPath(patchUri, lineNumber);
    if (!path) return undefined;

    const topLevel = this.findPatchTarget(path.names[0], patchUri);
    if (!topLevel) return undefined;
    if (path.names.length === 1) {
      return { uri: topLevel.uri, range: topLevel.range, path: path.path };
    }

    const file = this.fileTexts.get(topLevel.uri.toString());
    if (!file) return undefined;

    const stack: Array<{ name: string; line: number; character: number }> = [];
    for (let line = topLevel.range.start.line; line < file.lines.length; line++) {
      const text = file.lines[line];
      const match = text.match(STRUCT_DEFINITION);
      if (match) {
        const character = text.indexOf(match[1]);
        stack.push({ name: match[1], line, character });
        const names = stack.map((entry) => entry.name);
        if (names.length === path.names.length && names.every((name, index) => name === path.names[index])) {
          const current = stack[stack.length - 1];
          return {
            uri: topLevel.uri,
            range: new vscode.Range(
              new vscode.Position(current.line, current.character),
              new vscode.Position(current.line, current.character + current.name.length)
            ),
            path: path.path
          };
        }
      }

      const ends = (text.match(/struct\.end\b/g) ?? []).length;
      for (let i = 0; i < ends; i++) stack.pop();
      if (line > topLevel.range.start.line && stack.length === 0) break;
    }

    return undefined;
  }

  findPatchTarget(sid: string, patchUri: vscode.Uri): PrototypeNode | undefined {
    const entries = [...(this.prototypes.get(sid) ?? [])]
      .filter((entry) => entry.kind === 'definition' && entry.isReference);
    if (entries.length === 0) return undefined;

    const patchName = patchUri.path.substring(patchUri.path.lastIndexOf('/') + 1);
    const stem = patchName.replace(/\.cfg$/i, '').replace(/_patch(?:_.*)?$/i, '').toLowerCase();
    const sameFamily = entries.filter((entry) => {
      const name = entry.uri.path.substring(entry.uri.path.lastIndexOf('/') + 1).replace(/\.cfg$/i, '').toLowerCase();
      return name === stem;
    });

    return (sameFamily.length === 1 ? sameFamily[0] : undefined);
  }

  findPrototype(sid: string, sourceUri?: vscode.Uri): PrototypeNode | undefined {
    const entries = [...(this.prototypes.get(sid) ?? [])].filter((entry) => entry.kind === 'definition');

    // A mod bpatch always targets the vanilla definition. Do not let another
    // mod definition with the same SID become the inheritance root.
    if (sourceUri && this.isPatchAt(sourceUri, sid)) {
      return this.findPatchTarget(sid, sourceUri);
    }

    return this.sortPrototypeCandidates(entries, sourceUri)[0];
  }

  findPatches(sid: string, sourceUri?: vscode.Uri): PrototypeNode[] {
    const patches = [...(this.prototypes.get(sid) ?? [])].filter((entry) => entry.kind === 'patch');
    if (!sourceUri) return patches.sort(this.prototypeLocationSort);

    // On a patch hover only show the current patch. Same SIDs in other CFG
    // families patch their own vanilla nodes and are not sibling patches here.
    const source = sourceUri.toString();
    return patches
      .filter((entry) => entry.uri.toString() === source)
      .sort(this.prototypeLocationSort);
  }

  private isPatchAt(uri: vscode.Uri, sid: string): boolean {
    return (this.prototypes.get(sid) ?? []).some(
      (entry) => entry.kind === 'patch' && entry.uri.toString() === uri.toString()
    );
  }

  private readonly prototypeLocationSort = (a: PrototypeNode, b: PrototypeNode): number =>
    a.uri.fsPath.localeCompare(b.uri.fsPath) || a.range.start.line - b.range.start.line;

  getInheritanceChain(sid: string, sourceUri?: vscode.Uri, maxDepth = 32): InheritanceStep[] {
    const chain: InheritanceStep[] = [];
    const visited = new Set<string>();
    let currentSid = sid;
    let currentSource = sourceUri;

    for (let depth = 0; depth < maxDepth; depth++) {
      const key = currentSid.toLowerCase();
      if (visited.has(key)) {
        chain.push({ sid: currentSid, cycle: true });
        break;
      }
      visited.add(key);

      const node = this.findPrototype(currentSid, currentSource);
      if (!node) {
        chain.push({ sid: currentSid, unresolved: true });
        break;
      }

      chain.push({ sid: node.sid, uri: node.uri, isReference: node.isReference });
      if (!node.parent || /^\[\d+\]$/.test(node.parent)) break;

      currentSid = node.parent;
      currentSource = node.refurl ? this.resolveBaseGameRef(node.refurl) : node.uri;
    }

    return chain;
  }

  private addPrototype(
    sid: string,
    uri: vscode.Uri,
    line: number,
    character: number,
    attributes?: string
  ): void {
    const refurl = attributes?.match(/(?:^|;)\s*refurl\s*=\s*([^;}]+)/)?.[1]?.trim();
    const refkey = attributes?.match(/(?:^|;)\s*refkey\s*=\s*([^;}]+)/)?.[1]?.trim();
    const bpatch = attributes
      ? /(?:^|;)\s*bpatch(?:\s*(?:=\s*true)?)?(?=;|$)/i.test(attributes.trim())
      : false;
    const range = new vscode.Range(
      new vscode.Position(line, character),
      new vscode.Position(line, character + sid.length)
    );
    const entries = this.prototypes.get(sid) ?? [];
    entries.push({
      sid,
      uri,
      range,
      isReference: this.isReferencePath(uri),
      kind: bpatch ? 'patch' : 'definition',
      parent: bpatch ? undefined : refkey,
      refurl: bpatch ? undefined : refurl
    });
    this.prototypes.set(sid, entries);
  }

  private sortPrototypeCandidates(entries: PrototypeNode[], sourceUri?: vscode.Uri): PrototypeNode[] {
    return entries.sort((a, b) => {
      if (sourceUri) {
        const source = sourceUri.toString();
        const aLocal = a.uri.toString() === source ? 1 : 0;
        const bLocal = b.uri.toString() === source ? 1 : 0;
        if (aLocal !== bLocal) return bLocal - aLocal;
      }
      const referenceDifference = Number(b.isReference) - Number(a.isReference);
      if (referenceDifference !== 0) return referenceDifference;
      return a.uri.fsPath.localeCompare(b.uri.fsPath) || a.range.start.line - b.range.start.line;
    });
  }

  resolveBaseGameRef(refurl: string): vscode.Uri | undefined {
    if (!refurl.toLowerCase().startsWith('@basegame/')) return undefined;

    const requested = refurl.substring('@BaseGame/'.length).replace(/\\/g, '/').toLowerCase();
    const fileName = requested.substring(requested.lastIndexOf('/') + 1);
    const basePath = this.vanillaReferencePath();

    const candidates = [...this.fileTexts.values()]
      .map((entry) => entry.uri)
      .filter((uri) => {
        const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
        const lower = relative.toLowerCase();
        if (!basePath || (lower !== basePath && !lower.startsWith(basePath + '/'))) return false;
        return lower.endsWith('/' + requested) || lower.endsWith('/' + fileName) || lower === fileName;
      })
      .sort((a, b) => {
        const ar = vscode.workspace.asRelativePath(a, false).replace(/\\/g, '/').toLowerCase();
        const br = vscode.workspace.asRelativePath(b, false).replace(/\\/g, '/').toLowerCase();
        const aFull = ar.endsWith('/' + requested) ? 0 : 1;
        const bFull = br.endsWith('/' + requested) ? 0 : 1;
        return aFull - bFull || ar.localeCompare(br);
      });

    return candidates[0];
  }

  isReferenceUri(uri: vscode.Uri): boolean {
    return this.isReferencePath(uri);
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

  private vanillaReferencePath(): string {
    return vscode.workspace.getConfiguration('stalker2Cfg').get<string>('vanillaReferencePath', '')
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .replace(/\/$/, '')
      .toLowerCase();
  }

  private isReferencePath(uri: vscode.Uri): boolean {
    if (!vscode.workspace.getWorkspaceFolder(uri)) return false;
    const base = this.vanillaReferencePath();
    if (!base) return false;
    const relativePath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/').toLowerCase();
    return relativePath === base || relativePath.startsWith(base + '/');
  }

  private kindPriority(kind: DefinitionKind): number {
    return kind === 'struct' ? 0 : 1;
  }

  private removeFile(uri: vscode.Uri): void {
    this.fileTexts.delete(uri.toString());
    for (const [sid, entries] of this.prototypes) {
      const filtered = entries.filter((entry) => entry.uri.toString() !== uri.toString());
      if (filtered.length === 0) this.prototypes.delete(sid);
      else if (filtered.length !== entries.length) this.prototypes.set(sid, filtered);
    }
    // References depend on the complete set of known definitions. A full
    // rebuild recreates them; live file updates refresh them below.
    for (const [sid, entries] of this.definitions) {
      const filtered = entries.filter((entry) => entry.uri.toString() !== uri.toString());
      if (filtered.length === 0) this.definitions.delete(sid);
      else if (filtered.length !== entries.length) this.definitions.set(sid, filtered);
    }
  }
}
