import type { Node } from 'web-tree-sitter';
import type { Chunk } from './chunker';
import { detectLanguage, lineCommentPrefix, SupportedLanguage } from './languageDetection';
import type { ParserRegistry } from './parserRegistry';

export type FallbackChunker = (content: string, filePath: string) => Chunk[];

export interface AstChunkerLogger {
  debug?(message: string): void;
  warn?(message: string): void;
}

export interface AstChunkerDeps {
  parserRegistry: ParserRegistry;
  countTokens: (text: string) => number;
  maxTokens: number;
  fallback: FallbackChunker;
  logger?: AstChunkerLogger;
}

type CaptureKind = 'function' | 'method' | 'class' | 'impl' | 'decorated';

interface CapturedNode {
  node: Node;
  kind: CaptureKind;
}

// Node types that act as the "enclosing container" for method-style chunks.
// When a function/method lives inside one of these, we prefix its chunk with
// the container's name. Per-language to match each grammar.
const CONTAINER_TYPES: Record<SupportedLanguage, ReadonlySet<string>> = {
  typescript: new Set(['class_declaration', 'interface_declaration']),
  tsx: new Set(['class_declaration', 'interface_declaration']),
  javascript: new Set(['class_declaration']),
  python: new Set(['class_definition']),
  go: new Set([]), // Go methods use their receiver; handled separately.
  java: new Set([
    'class_declaration',
    'interface_declaration',
    'enum_declaration',
    'record_declaration',
  ]),
  csharp: new Set([
    'class_declaration',
    'interface_declaration',
    'struct_declaration',
    'enum_declaration',
    'record_declaration',
  ]),
  rust: new Set(['impl_item']),
  ruby: new Set(['class', 'module']),
};

export async function chunkByAst(
  content: string,
  filePath: string,
  deps: AstChunkerDeps,
): Promise<Chunk[]> {
  if (!content) return [];

  const language = detectLanguage(filePath);
  if (!language) return deps.fallback(content, filePath);

  let loaded;
  try {
    loaded = await deps.parserRegistry.get(language);
  } catch (err) {
    deps.logger?.warn?.(
      `ast: failed to load grammar for ${language} (${filePath}): ${errMsg(err)} \u2014 falling back`,
    );
    return deps.fallback(content, filePath);
  }

  let tree;
  try {
    tree = loaded.parser.parse(content);
  } catch (err) {
    deps.logger?.warn?.(`ast: parse error for ${filePath}: ${errMsg(err)} \u2014 falling back`);
    return deps.fallback(content, filePath);
  }
  if (!tree) return deps.fallback(content, filePath);

  let matches;
  try {
    matches = loaded.query.matches(tree.rootNode);
  } catch (err) {
    deps.logger?.warn?.(`ast: query error for ${filePath}: ${errMsg(err)} \u2014 falling back`);
    tree.delete();
    return deps.fallback(content, filePath);
  }

  const captured: CapturedNode[] = [];
  for (const match of matches) {
    for (const cap of match.captures) {
      const kind = captureKind(cap.name);
      if (!kind) continue;
      captured.push({ node: cap.node, kind });
    }
  }

  const emittable = selectEmittable(captured);

  const chunks: Chunk[] = [];
  for (const entry of emittable) {
    chunks.push(...buildChunkForEntry(entry, language, deps));
  }

  tree.delete();

  // Empty AST result (e.g. file with only imports/top-level statements, no
  // function/class defs) — fall back so the file still contributes chunks.
  if (chunks.length === 0) return deps.fallback(content, filePath);

  chunks.sort((a, b) => a.startLine - b.startLine);
  return chunks;
}

function captureKind(name: string): CaptureKind | null {
  switch (name) {
    case 'definition.function':
      return 'function';
    case 'definition.method':
      return 'method';
    case 'definition.class':
      return 'class';
    case 'definition.impl':
      return 'impl';
    case 'definition.decorated':
      return 'decorated';
    default:
      return null;
  }
}

// Determines which captures should produce chunks.
//
// Rules:
//   - `impl` captures never emit on their own; they only exist so methods
//     inside Rust impl blocks can look up their receiver type.
//   - A `decorated` (Python) capture replaces the inner function/class
//     capture it wraps — we emit the decorated span and drop the inner.
//   - `function` / `method` / `decorated` captures emit unless strictly
//     contained inside another emittable function/method/decorated capture
//     (prevents nested helper functions from double-chunking).
//   - `class` captures emit only if they contain no other emittable capture
//     (otherwise the inner defs cover them).
function selectEmittable(captured: CapturedNode[]): CapturedNode[] {
  // Dedup the same node captured twice under different names.
  const byId = new Map<number, CapturedNode>();
  for (const cap of captured) {
    const existing = byId.get(cap.node.id);
    if (!existing || kindPriority(cap.kind) > kindPriority(existing.kind)) {
      byId.set(cap.node.id, cap);
    }
  }
  const all = [...byId.values()];

  // Drop the inner function/class node when wrapped by a `decorated` node.
  const decoratedIds = new Set(all.filter((c) => c.kind === 'decorated').map((c) => c.node.id));
  const candidates = all.filter((c) => {
    if (c.kind === 'impl') return false;
    if (c.kind === 'function' || c.kind === 'class' || c.kind === 'method') {
      const parent = c.node.parent;
      if (parent && decoratedIds.has(parent.id)) return false;
    }
    return true;
  });

  const emitLikeFn = (c: CapturedNode): boolean =>
    c.kind === 'function' || c.kind === 'method' || c.kind === 'decorated';

  const result: CapturedNode[] = [];
  for (const c of candidates) {
    if (emitLikeFn(c)) {
      // Drop if strictly contained in another function-like candidate.
      const containedInFn = candidates.some(
        (other) => other !== c && emitLikeFn(other) && strictlyContains(other.node, c.node),
      );
      if (containedInFn) continue;
      result.push(c);
    } else if (c.kind === 'class') {
      const containsOther = candidates.some(
        (other) => other !== c && other.kind !== 'impl' && strictlyContains(c.node, other.node),
      );
      if (containsOther) continue;
      result.push(c);
    }
  }
  return result;
}

function kindPriority(kind: CaptureKind): number {
  // Higher wins when the same node is captured under multiple names.
  // decorated > method > function > class > impl.
  switch (kind) {
    case 'decorated':
      return 4;
    case 'method':
      return 3;
    case 'function':
      return 2;
    case 'class':
      return 1;
    case 'impl':
      return 0;
  }
}

function strictlyContains(outer: Node, inner: Node): boolean {
  if (outer.id === inner.id) return false;
  return outer.startIndex <= inner.startIndex && outer.endIndex >= inner.endIndex;
}

function buildChunkForEntry(
  entry: CapturedNode,
  language: SupportedLanguage,
  deps: AstChunkerDeps,
): Chunk[] {
  const { node } = entry;
  const text = node.text;
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  const containerName = resolveContainerName(node, language);
  const body =
    containerName !== null
      ? `${lineCommentPrefix(language)} Class: ${containerName}\n${text}`
      : text;

  const tokenCount = deps.countTokens(body);

  if (tokenCount <= deps.maxTokens) {
    return [{ content: body, startLine, endLine, tokenCount }];
  }

  // Oversized — delegate to the token-split fallback scoped to this node.
  // Use the raw text (without the parent-class header) so line offsets stay
  // aligned with the source; add the header only to the first sub-chunk.
  const sub = deps.fallback(text, '');
  if (sub.length === 0) {
    return [{ content: body, startLine, endLine, tokenCount }];
  }

  return sub.map((c, i) => {
    const content =
      i === 0 && containerName !== null
        ? `${lineCommentPrefix(language)} Class: ${containerName}\n${c.content}`
        : c.content;
    return {
      content,
      startLine: startLine + (c.startLine - 1),
      endLine: startLine + (c.endLine - 1),
      tokenCount: i === 0 && containerName !== null ? deps.countTokens(content) : c.tokenCount,
    };
  });
}

function resolveContainerName(node: Node, language: SupportedLanguage): string | null {
  const containerTypes = CONTAINER_TYPES[language];

  // Go methods get their receiver type as a prefix.
  if (language === 'go' && node.type === 'method_declaration') {
    const receiver = node.childForFieldName('receiver');
    const receiverText = receiver?.text.trim();
    if (receiverText) return receiverText;
    return null;
  }

  let cur: Node | null = node.parent;
  while (cur) {
    if (containerTypes.has(cur.type)) {
      const name = extractContainerName(cur, language);
      if (name) return name;
    }
    cur = cur.parent;
  }
  return null;
}

function extractContainerName(container: Node, language: SupportedLanguage): string | null {
  // Rust impl blocks have a `type` field (and optionally a `trait` field).
  if (language === 'rust' && container.type === 'impl_item') {
    const traitField = container.childForFieldName('trait');
    const typeField = container.childForFieldName('type');
    if (traitField && typeField) {
      return `${traitField.text} for ${typeField.text}`;
    }
    return typeField?.text ?? null;
  }

  const nameField = container.childForFieldName('name');
  if (nameField) return nameField.text;

  // Fallback: first identifier-ish named child.
  for (let i = 0; i < container.namedChildCount; i++) {
    const child = container.namedChild(i);
    if (child && /identifier/.test(child.type)) return child.text;
  }
  return null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
