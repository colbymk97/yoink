import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { chunkByAst } from '../../../src/ingestion/astChunker';
import { ParserRegistry } from '../../../src/ingestion/parserRegistry';
import type { Chunk } from '../../../src/ingestion/chunker';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const FIXTURE_DIR = join(REPO_ROOT, 'test', 'fixtures', 'ast');

const countTokens = (text: string): number => {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
};

// Minimal token-split fallback used by tests. Mirrors the real Chunker's
// behavior closely enough to exercise the fallback code path without pulling
// the whole Chunker class into scope.
function tokenFallback(content: string, _filePath: string): Chunk[] {
  const lines = content.split('\n');
  if (lines.length === 0) return [];
  const chunkSize = 2;
  const chunks: Chunk[] = [];
  for (let i = 0; i < lines.length; i += chunkSize) {
    const slice = lines.slice(i, i + chunkSize);
    chunks.push({
      content: slice.join('\n'),
      startLine: i + 1,
      endLine: Math.min(i + slice.length, lines.length),
      tokenCount: countTokens(slice.join('\n')),
    });
  }
  return chunks;
}

let registry: ParserRegistry;

beforeAll(() => {
  registry = new ParserRegistry({
    extensionPath: REPO_ROOT,
    queryDir: join(REPO_ROOT, 'src', 'chunking', 'queries'),
  });
});

describe('chunkByAst — TypeScript', () => {
  it('produces one chunk per top-level function and each method, not the containing class', async () => {
    const content = readFileSync(join(FIXTURE_DIR, 'sample.ts'), 'utf8');
    const chunks = await chunkByAst(content, 'sample.ts', {
      parserRegistry: registry,
      countTokens,
      maxTokens: 10_000,
      fallback: tokenFallback,
    });

    // greet (1 function) + constructor + validateToken + addUser (3 methods) = 4 chunks.
    // The UserService class itself should NOT be emitted because it contains methods.
    expect(chunks).toHaveLength(4);

    const greet = chunks.find((c) => c.content.includes('function greet'));
    expect(greet).toBeDefined();
    expect(greet!.content.startsWith('// Class:')).toBe(false);

    const validate = chunks.find((c) => c.content.includes('validateToken'));
    expect(validate).toBeDefined();
    expect(validate!.content.startsWith('// Class: UserService\n')).toBe(true);

    const ctor = chunks.find((c) => c.content.includes('constructor()'));
    expect(ctor).toBeDefined();
    expect(ctor!.content.startsWith('// Class: UserService\n')).toBe(true);

    // Line numbers are 1-based and cover the method body.
    expect(validate!.startLine).toBeLessThan(validate!.endLine);
    expect(validate!.startLine).toBeGreaterThanOrEqual(1);
  });

  it('falls back to token-split when the file only has non-definition code', async () => {
    const chunks = await chunkByAst(
      "const x = 1;\nconst y = 2;\nconsole.log(x + y);\n",
      'top.ts',
      {
        parserRegistry: registry,
        countTokens,
        maxTokens: 10_000,
        fallback: tokenFallback,
      },
    );
    // No functions/classes — fallback returns at least one chunk.
    expect(chunks.length).toBeGreaterThan(0);
    // None of the chunks should have a parent-class prefix (they came from the fallback).
    for (const c of chunks) {
      expect(c.content.startsWith('// Class:')).toBe(false);
    }
  });
});

describe('chunkByAst — Python', () => {
  it('prefixes methods with "# Class: Name" and keeps module-level functions plain', async () => {
    const content = readFileSync(join(FIXTURE_DIR, 'sample.py'), 'utf8');
    const chunks = await chunkByAst(content, 'sample.py', {
      parserRegistry: registry,
      countTokens,
      maxTokens: 10_000,
      fallback: tokenFallback,
    });

    // top_level + __init__ + hello + decorated_free = 4 chunks; Greeter class itself suppressed.
    expect(chunks).toHaveLength(4);

    const topLevel = chunks.find((c) => c.content.includes('def top_level'));
    expect(topLevel).toBeDefined();
    expect(topLevel!.content.startsWith('# Class:')).toBe(false);

    const hello = chunks.find((c) => c.content.includes('def hello'));
    expect(hello).toBeDefined();
    expect(hello!.content.startsWith('# Class: Greeter\n')).toBe(true);
  });
});

describe('chunkByAst — fallback paths', () => {
  it('falls back to token-split for unsupported extensions', async () => {
    const content = 'local function foo()\n  return 1\nend\n';
    let fallbackCalled = false;
    const chunks = await chunkByAst(content, 'script.lua', {
      parserRegistry: registry,
      countTokens,
      maxTokens: 100,
      fallback: (c, p) => {
        fallbackCalled = true;
        return tokenFallback(c, p);
      },
    });
    expect(fallbackCalled).toBe(true);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('falls back when grammar loading fails', async () => {
    const failingRegistry: ParserRegistry = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async get() {
        throw new Error('boom');
      },
    } as unknown as ParserRegistry;

    let fallbackCalled = false;
    const chunks = await chunkByAst('function x() {}\n', 'x.ts', {
      parserRegistry: failingRegistry,
      countTokens,
      maxTokens: 100,
      fallback: (c, p) => {
        fallbackCalled = true;
        return tokenFallback(c, p);
      },
    });
    expect(fallbackCalled).toBe(true);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('sub-splits an oversized function via the fallback with offset line numbers', async () => {
    const fnLines = Array.from({ length: 40 }, (_, i) => `  const x${i} = ${i};`);
    const content = ['', '', 'function big() {', ...fnLines, '}', ''].join('\n');
    // Function starts at line 3 in the source file.

    const chunks = await chunkByAst(content, 'big.ts', {
      parserRegistry: registry,
      countTokens,
      maxTokens: 5, // forces oversized handling
      fallback: tokenFallback,
    });

    // The big function should have been split into multiple sub-chunks.
    expect(chunks.length).toBeGreaterThan(1);
    // Line numbers should be source-relative: the first sub-chunk starts at
    // the function's start line (3), not at 1.
    expect(chunks[0].startLine).toBe(3);
    // And later sub-chunks advance past line 3.
    expect(chunks[chunks.length - 1].endLine).toBeGreaterThan(3);
  });
});
