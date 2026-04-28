import { describe, it, expect } from 'vitest';
import { Chunker } from '../../../src/ingestion/chunker';

// Simple tokenizer: 1 token per word (split on whitespace)
const wordCount = (text: string): number => {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
};

describe('Chunker', () => {
  it('returns empty array for empty content', async () => {
    const chunker = new Chunker();
    expect(await chunker.chunkFile('', 'test.txt')).toEqual([]);
  });

  it('returns a single chunk for small files', async () => {
    const chunker = new Chunker({ maxTokens: 100, overlapTokens: 10 });
    const content = 'line one\nline two\nline three';
    const chunks = await chunker.chunkFile(content, 'small.txt');

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(content);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(3);
  });

  it('splits large files into multiple chunks', async () => {
    const chunker = new Chunker({
      maxTokens: 10,
      overlapTokens: 0,
      countTokens: wordCount,
    });

    // 5 words per line × 6 lines = 30 words → should produce 3 chunks
    const lines = Array.from({ length: 6 }, (_, i) => `word1 word2 word3 word4 line${i}`);
    const content = lines.join('\n');
    const chunks = await chunker.chunkFile(content, 'big.txt');

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(chunk.startLine).toBeGreaterThanOrEqual(1);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
    }
  });

  it('produces overlapping chunks', async () => {
    const chunker = new Chunker({
      maxTokens: 10,
      overlapTokens: 5,
      countTokens: wordCount,
    });

    const lines = [
      'alpha bravo charlie delta echo',
      'foxtrot golf hotel india juliet',
      'kilo lima mike november oscar',
      'papa quebec romeo sierra tango',
    ];
    const content = lines.join('\n');
    const chunks = await chunker.chunkFile(content, 'overlap.txt');

    if (chunks.length >= 2) {
      expect(chunks[1].startLine).toBeLessThan(chunks[0].endLine + 1);
    }
  });

  it('uses 1-based line numbers', async () => {
    const chunker = new Chunker({ maxTokens: 1000, overlapTokens: 0 });
    const content = 'first\nsecond\nthird';
    const chunks = await chunker.chunkFile(content, 'test.txt');

    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(3);
  });

  it('reports token count per chunk', async () => {
    const chunker = new Chunker({
      maxTokens: 10,
      overlapTokens: 0,
      countTokens: wordCount,
    });

    const content = 'one two three four five\nsix seven eight nine ten\neleven twelve';
    const chunks = await chunker.chunkFile(content, 'test.txt');

    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeGreaterThan(0);
      expect(chunk.tokenCount).toBeLessThanOrEqual(12);
    }
  });

  it('never produces empty chunks', async () => {
    const chunker = new Chunker({
      maxTokens: 5,
      overlapTokens: 2,
      countTokens: wordCount,
    });

    const lines = Array.from({ length: 20 }, (_, i) => `word${i} another${i}`);
    const content = lines.join('\n');
    const chunks = await chunker.chunkFile(content, 'test.txt');

    for (const chunk of chunks) {
      expect(chunk.content.length).toBeGreaterThan(0);
    }
  });

  it('guarantees forward progress even with very small maxTokens', async () => {
    const chunker = new Chunker({
      maxTokens: 1,
      overlapTokens: 0,
      countTokens: wordCount,
    });

    const content = 'hello world\nfoo bar';
    const chunks = await chunker.chunkFile(content, 'test.txt');

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.endLine).toBe(2);
  });

  it('handles single-line files', async () => {
    const chunker = new Chunker({ maxTokens: 100, overlapTokens: 10 });
    const chunks = await chunker.chunkFile('single line content', 'one.txt');

    expect(chunks).toHaveLength(1);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(1);
  });

  it('uses default char/4 tokenizer when no countTokens provided', async () => {
    const chunker = new Chunker({ maxTokens: 10, overlapTokens: 0 });
    const content = 'a'.repeat(40) + '\n' + 'b'.repeat(40);
    const chunks = await chunker.chunkFile(content, 'test.txt');

    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Chunker.routeStrategy', () => {
  it('routes markdown files to markdown-heading', () => {
    expect(Chunker.routeStrategy('README.md')).toBe('markdown-heading');
    expect(Chunker.routeStrategy('docs/guide.MDX')).toBe('markdown-heading');
    expect(Chunker.routeStrategy('nested/path/NOTES.md')).toBe('markdown-heading');
  });

  it('routes AST-supported source files to ast-based', () => {
    expect(Chunker.routeStrategy('src/foo.ts')).toBe('ast-based');
    expect(Chunker.routeStrategy('app.tsx')).toBe('ast-based');
    expect(Chunker.routeStrategy('lib/util.py')).toBe('ast-based');
    expect(Chunker.routeStrategy('main.go')).toBe('ast-based');
    expect(Chunker.routeStrategy('Example.java')).toBe('ast-based');
    expect(Chunker.routeStrategy('Service.cs')).toBe('ast-based');
    expect(Chunker.routeStrategy('mod.rs')).toBe('ast-based');
    expect(Chunker.routeStrategy('app.rb')).toBe('ast-based');
  });

  it('routes GitHub Actions workflow YAML to file-level', () => {
    expect(Chunker.routeStrategy('.github/workflows/ci.yml')).toBe('file-level');
    expect(Chunker.routeStrategy('.github/workflows/release.yaml')).toBe('file-level');
    expect(Chunker.routeStrategy('.github\\workflows\\ci.yml')).toBe('file-level');
    expect(Chunker.routeStrategy('C:\\repo\\.github\\workflows\\release.yaml')).toBe('file-level');
  });

  it('routes action.yml/action.yaml to file-level', () => {
    expect(Chunker.routeStrategy('action.yml')).toBe('file-level');
    expect(Chunker.routeStrategy('actions/checkout/action.yaml')).toBe('file-level');
    expect(Chunker.routeStrategy('actions\\checkout\\action.yml')).toBe('file-level');
  });

  it('falls back to token-split for unknown file types', () => {
    expect(Chunker.routeStrategy('config.json')).toBe('token-split');
    expect(Chunker.routeStrategy('spec.yaml')).toBe('token-split');
    expect(Chunker.routeStrategy('notes.txt')).toBe('token-split');
    expect(Chunker.routeStrategy('LICENSE')).toBe('token-split');
  });
});

describe('Chunker — per-file routing (default)', () => {
  it('uses markdown-heading behavior for .md files', async () => {
    const chunker = new Chunker({ maxTokens: 1000 });
    const content = '# Alpha\nbody a\n# Beta\nbody b';
    const chunks = await chunker.chunkFile(content, 'README.md');

    expect(chunks).toHaveLength(2);
    expect(chunks[0].content).toContain('# Alpha');
    expect(chunks[1].content).toContain('# Beta');
  });

  it('uses file-level behavior for workflow YAML', async () => {
    const chunker = new Chunker({ maxTokens: 5, countTokens: wordCount });
    const content = 'name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest';
    const chunks = await chunker.chunkFile(content, '.github/workflows/ci.yml');

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(content);
  });

  it('uses file-level behavior for action.yml', async () => {
    const chunker = new Chunker({ maxTokens: 5, countTokens: wordCount });
    const content = 'name: my-action\ndescription: Does a thing\nruns:\n  using: node20';
    const chunks = await chunker.chunkFile(content, 'path/to/action.yml');

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(content);
  });

  it('falls back to token-split for ast files when astDeps is missing', async () => {
    const chunker = new Chunker({ maxTokens: 10, countTokens: wordCount });
    const content = 'function a() { return 1 }\nfunction b() { return 2 }\nfunction c() { return 3 }';
    const chunks = await chunker.chunkFile(content, 'foo.ts');

    // Should not throw — degrades to token-split when parser registry absent.
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it('uses token-split for generic text files', async () => {
    const chunker = new Chunker({ maxTokens: 100, overlapTokens: 0 });
    const content = 'just plain text\nwith a few lines\nof content';
    const chunks = await chunker.chunkFile(content, 'notes.txt');

    expect(chunks).toHaveLength(1);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(3);
  });
});

describe('Chunker — file-level strategy (forced)', () => {
  it('returns a single chunk for the entire file', async () => {
    const chunker = new Chunker({ strategy: 'file-level', maxTokens: 10 });
    const content = 'line one\nline two\nline three\nline four\nline five';
    const chunks = await chunker.chunkFile(content, 'action.yml');

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(content);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(5);
  });

  it('returns empty array for empty content', async () => {
    const chunker = new Chunker({ strategy: 'file-level' });
    expect(await chunker.chunkFile('', 'empty.yml')).toEqual([]);
  });

  it('reports correct token count for a single-chunk file', async () => {
    const chunker = new Chunker({
      strategy: 'file-level',
      countTokens: wordCount,
    });
    const content = 'alpha bravo charlie\ndelta echo foxtrot';
    const chunks = await chunker.chunkFile(content, 'wf.yml');

    expect(chunks[0].tokenCount).toBe(6);
  });
});

describe('Chunker — markdown-heading strategy (forced)', () => {
  it('splits content on # headings', async () => {
    const chunker = new Chunker({ strategy: 'markdown-heading', maxTokens: 1000 });
    const content = [
      '# Introduction',
      'Some intro text.',
      '',
      '# Usage',
      'Usage details here.',
    ].join('\n');

    const chunks = await chunker.chunkFile(content, 'README.md');

    expect(chunks).toHaveLength(2);
    expect(chunks[0].content).toContain('# Introduction');
    expect(chunks[1].content).toContain('# Usage');
  });

  it('uses 1-based line numbers relative to the original file', async () => {
    const chunker = new Chunker({ strategy: 'markdown-heading', maxTokens: 1000 });
    const content = '# First\nfirst body\n# Second\nsecond body';
    const chunks = await chunker.chunkFile(content, 'doc.md');

    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(2);
    expect(chunks[1].startLine).toBe(3);
    expect(chunks[1].endLine).toBe(4);
  });

  it('sub-chunks oversized sections with token-split and preserves line offsets', async () => {
    const chunker = new Chunker({
      strategy: 'markdown-heading',
      maxTokens: 3,
      overlapTokens: 0,
      countTokens: wordCount,
    });
    const content = [
      '# Big Section',
      'one two three',
      'four five six',
      'seven eight nine',
    ].join('\n');

    const chunks = await chunker.chunkFile(content, 'big.md');

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.startLine).toBeGreaterThanOrEqual(1);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
    }
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.endLine).toBe(4);
  });

  it('handles files with no headings as a single section', async () => {
    const chunker = new Chunker({ strategy: 'markdown-heading', maxTokens: 1000 });
    const content = 'No headings here.\nJust plain text.\n';
    const chunks = await chunker.chunkFile(content, 'plain.md');

    expect(chunks).toHaveLength(1);
    expect(chunks[0].startLine).toBe(1);
  });

  it('returns empty array for empty content', async () => {
    const chunker = new Chunker({ strategy: 'markdown-heading' });
    expect(await chunker.chunkFile('', 'empty.md')).toEqual([]);
  });

  it('never produces whitespace-only chunks from headings with no body', async () => {
    const chunker = new Chunker({ strategy: 'markdown-heading' });
    const content = '# First\n\n## Second\n\n### Third\n';
    const chunks = await chunker.chunkFile(content, 'readme.md');
    for (const chunk of chunks) {
      expect(chunk.content.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('Chunker — ast-based strategy (forced)', () => {
  it('throws a clear error when ast-based is forced without astDeps', async () => {
    const chunker = new Chunker({ strategy: 'ast-based' });
    await expect(chunker.chunkFile('function x() {}', 'x.ts')).rejects.toThrow(/parserRegistry/);
  });
});

describe('Chunker — per-input limit', () => {
  // Simulate the OpenAI 8192-token cap with a lower threshold. wordCount
  // treats each whitespace-separated token as 1 token.
  const bigWord = 'x';

  it('splits an oversized file-level YAML on top-level keys', async () => {
    const chunker = new Chunker({
      countTokens: wordCount,
      maxTokens: 50,
    });
    // Each section has ~9000 "words" — far over the 8000 per-input limit.
    const big = Array.from({ length: 9000 }, () => bigWord).join(' ');
    const content = [
      'name: my workflow',
      `jobs: ${big}`,
      `steps: ${big}`,
    ].join('\n');

    const chunks = await chunker.chunkFile(content, '.github/workflows/ci.yml');

    // Must produce multiple chunks, each under the per-input cap.
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(8000);
    }
  });

  it('char-splits chunks whose content still exceeds the per-input cap', async () => {
    // Force file-level on a non-YAML path so the YAML key-split doesn't run
    // and we exercise the safety net. A single enormous line can't be split
    // by token-split either (line > maxTokens is emitted whole).
    const chunker = new Chunker({
      strategy: 'file-level',
      countTokens: wordCount,
    });
    const huge = Array.from({ length: 20000 }, () => bigWord).join(' ');
    const chunks = await chunker.chunkFile(huge, 'blob.bin');

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(8000);
    }
  });

  it('re-splits dense slices that still exceed the per-input cap', async () => {
    const denseCount = (text: string): number =>
      Array.from(text).reduce((acc, ch) => acc + (ch === 'x' ? 1 : 0), 0);
    const chunker = new Chunker({
      strategy: 'file-level',
      countTokens: denseCount,
      maxInputTokens: 10,
    });
    const huge = `${'x'.repeat(30)}${'a'.repeat(300)}`;
    const chunks = await chunker.chunkFile(huge, 'blob.css');

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(10);
    }
  });
});
